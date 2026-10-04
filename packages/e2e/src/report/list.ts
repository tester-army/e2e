/**
 * Human-readable list reporter, styled after vitest's default reporter: one
 * block per test file and target with each test's agent steps nested, a
 * `Failed Tests` section with code frames, and a padded summary. On a TTY a
 * live window below the log shows the running tree (`RunningTree`) and the
 * counters.
 */

import path from 'node:path';
import picocolors from 'picocolors';
import type { SerializedError } from '../internal/errors.ts';
import { packageVersion } from '../internal/package-version.ts';
import type { RunEvent, RunEventFact, RunEventOf, RunEventResult, SetupStep } from '../run/events.ts';
import { failureBeforeSkip, type ArtifactRecord, type AttemptRecord, type FailureEvidence, type ResultStatus, type SerialGroupRecord } from '../run/records.ts';
import type { Reporter, ReporterSummary } from '../types.ts';
import { codeFrame, userFrame } from './code-frame.ts';
import {
  addCacheTally,
  addModelTally,
  addUsage,
  aiSegment,
  bounded,
  cacheText,
  durationText,
  fitColumns,
  emptyCacheTally,
  emptyCounters,
  emptyUsage,
  F_CHECK,
  F_CROSS,
  F_POINTER,
  fileOutcome,
  formatClock,
  formatTime,
  modelsText,
  padTitle,
  rule,
  stateString,
  statusBucket,
  stepsCacheTally,
  repeatSuffix,
  stepsModelTally,
  stepsUsage,
  sumUsage,
  tally,
  terminalColumns,
  usageText,
  type AiUsage,
  type CacheTally,
  type Colors,
  type Counters,
  type ModelTally,
} from './format.ts';
import { ExploreView } from './list-explore.ts';
import { isShownEvent, type FileGroup, type RunningTest, type TestLine } from './list-model.ts';
import { stepLine } from './list-steps.ts';
import { LiveWindow } from './live-window.ts';
import { repeatGroups, repeatLine, repeatSummary, type RepeatRun } from './repeats.ts';
import { RunningTree } from './running-tree.ts';

const F_DOWN = '↓';
const F_RIGHT = '→';
/** Indentation under a badge line, matching vitest's banner padding. */
const BADGE_PADDING = '      ';
/** Indentation of a test line under its file line. */
const TEST_INDENT = '   ';
/** Indentation of a finished agent step under its test line in a file block. */
const STEP_INDENT = '     ';
/**
 * Badge backgrounds, assigned to targets in declaration order. Bright variants
 * because GitHub Actions renders plain yellow as dark brown, which swallows the
 * black label.
 */
const BADGE_COLORS = ['bgYellowBright', 'bgCyanBright', 'bgGreenBright', 'bgMagentaBright'] as const;

/** Indentation of the `→ first error line` under a failed test in a file block. */
const ERROR_GLANCE_INDENT = 7;

export interface ListReporterOutput {
  write(line: string): void;
  /** Raw control write for live window rendering; omit to disable it. */
  raw?(text: string): void;
}

export interface ListReporterOptions {
  /** Paint the live window; defaults to whether stdout is a TTY. */
  live?: boolean;
  /** Emit ANSI colors; defaults to picocolors' detection (TTY, CI, FORCE_COLOR). */
  colors?: boolean;
}

/**
 * The identity of one pair across `test-started`, `step`, and `test-finished`:
 * a test runs once per agent it is pinned to, on each target, and once per
 * `--repeat-each` run.
 */
function pairKey(testId: string, agent: string, target: string, repeat: number): string {
  return `${testId}@${agent}@${target}@${repeat}`;
}

/** What a test line and a failure entry need from a result's execution. */
interface ResultDetails {
  readonly durationMs: number;
  readonly usage: AiUsage;
  /** The models its steps reported, with their call counts. */
  readonly models: ModelTally;
  readonly cache: CacheTally;
  readonly error: SerializedError | undefined;
  /** Where the recordings the attempts kept are, in attempt order: report-relative paths, or hosted URLs. */
  readonly videos: readonly string[];
  /** What the runner saw when the last failure landed, with the screen text's report path when it kept one. */
  readonly failure: FailureEvidence | undefined;
  readonly screenPath: string | undefined;
}

/** Details of an ordinary result: summed over its attempts, the error from the last. */
function attemptDetails(attempts: readonly AttemptRecord[]): ResultDetails {
  const steps = attempts.map((attempt) => attempt.steps);
  // A retry the run interrupted tells nothing; the failure before it is the verdict.
  const told = attempts.findLast((attempt) => attempt.status !== 'interrupted') ?? attempts.at(-1);
  return {
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    usage: stepsUsage(steps),
    models: stepsModelTally(steps),
    cache: stepsCacheTally(steps),
    error: told?.error,
    videos: videoPaths(attempts),
    ...failureOf(told),
  };
}

/** The failure evidence of one attempt, and the path of the screen text it points at. */
function failureOf(
  attempt: { readonly failure?: FailureEvidence | undefined; readonly artifacts: readonly ArtifactRecord[] } | undefined,
): Pick<ResultDetails, 'failure' | 'screenPath'> {
  const failure = attempt?.failure;
  const screen = failure?.screen === undefined ? undefined : attempt?.artifacts.find((artifact) => artifact.id === failure.screen);
  return { failure, screenPath: screen?.path };
}

/** Where each video these attempts kept is, in order: a report-relative path, or the URL of one a hosted service keeps. */
function videoPaths(attempts: readonly { readonly artifacts: readonly ArtifactRecord[] }[]): string[] {
  const paths: string[] = [];
  for (const attempt of attempts) {
    for (const artifact of attempt.artifacts) {
      if (artifact.kind !== 'video') continue;
      const where = artifact.url ?? artifact.path;
      if (where !== undefined) paths.push(where);
    }
  }
  return paths;
}

/**
 * Details of one serial member, read from its group: member results carry no
 * attempts of their own. Duration and usage sum over every group attempt the
 * member ran in. The error is the member's own from the last attempt; a member
 * that attempt never ran (skipped, or absent after a launch failure) inherits
 * the attempt's error, since that is what stopped it.
 */
function serialMemberDetails(group: SerialGroupRecord, testId: string): ResultDetails {
  const runs = group.attempts.map((attempt) => ({
    attempt,
    member: attempt.members.find((member) => member.testId === testId),
  }));
  const last = runs.findLast((run) => run.attempt.status !== 'interrupted') ?? runs.at(-1);
  const own = last?.member;
  const neverRan = own === undefined || own.status === 'skipped';
  const steps = runs.map((run) => run.member?.steps ?? []);
  return {
    durationMs: runs.reduce((total, run) => total + (run.member?.durationMs ?? 0), 0),
    usage: stepsUsage(steps),
    models: stepsModelTally(steps),
    cache: stepsCacheTally(steps),
    error: own?.error ?? (neverRan ? last?.attempt.error : undefined),
    // The group's recording covers every member, so a failed member points at it.
    videos: videoPaths(group.attempts),
    ...failureOf(own === undefined ? undefined : { failure: own.failure, artifacts: last?.attempt.artifacts ?? [] }),
  };
}

/** One failed pair, held for the `Failed Tests` section, or a skipped one for `Skipped After Failure`. */
interface Failure {
  readonly group: FileGroup;
  readonly title: string;
  readonly status: ResultStatus;
  readonly error: SerializedError | undefined;
  /** Where the recordings the failed attempts kept are, if any: report-relative paths, or hosted URLs. */
  readonly videos: readonly string[];
  readonly failure: FailureEvidence | undefined;
  readonly screenPath: string | undefined;
}

const DEFAULT_OUTPUT: ListReporterOutput = {
  write: (line) => process.stdout.write(`${line}\n`),
  raw: (text) => process.stdout.write(text),
};

/**
 * Renders the run's event stream as the CLI's human-readable output. The
 * reporter is one sink on the run's single event spine, so it can only show
 * what every other sink receives.
 */
export class ListReporter implements Reporter {
  readonly name = 'list';
  private readonly pc: Colors;
  private readonly window: LiveWindow;
  private readonly tree: RunningTree;
  private readonly separator: string;
  private projectRoot: string | undefined;
  private artifactsRoot: string | undefined;
  /** Selected targets in declaration order; decides each badge's color. */
  private targets: readonly string[] = [];
  /** When the run was launched (`run-started`): what a run that never reached `plan` reports. */
  private launchedAt = new Date();
  /**
   * When the run began executing (`plan`): the summary's `Start at` and the
   * origin of `Duration`. Undefined until then, so the clock never ticks
   * while a first-run download narrates above the live window.
   */
  private startedAt: Date | undefined;
  /** File groups keyed `${target}\u0000${file}`, in first-seen order. */
  private readonly groups = new Map<string, FileGroup>();
  /** Pairs that started and whose result is still to come, keyed by `pairKey`, in start order. */
  private readonly pairs = new Map<string, RunningTest>();
  /** Whether a live window paints; without one, finished steps stream permanently. */
  private readonly live: boolean;
  private readonly failures: Failure[] = [];
  private readonly skippedFailures: Failure[] = [];
  /** Every finished test's run, for the `Repeats` summary of a `--repeat-each` run. */
  private readonly runs: { key: string; label: string; run: RepeatRun }[] = [];
  /**
   * Serial groups whose members' results are still to come, by group id. The
   * runner emits a group before its member results, and a member's details
   * live only in the group.
   */
  private readonly pendingSerial = new Map<string, { group: SerialGroupRecord; remaining: number }>();
  /** Run-level errors, printed once at the end; the stream carries them as they happen. */
  private readonly errors: SerializedError[] = [];
  /**
   * Whether the run was cut short. An interrupt during service or app startup
   * lands before discovery, so the counters stay at zero; the summary must not
   * read that as "no test files".
   */
  private interrupted = false;
  /**
   * The setup step in flight, ticking in the live window. `narrated` once a
   * notice printed under it: a step that said something (a browser download)
   * prints its total when done, a silent one (an instant `prepare`) does not.
   */
  private inFlight: { readonly step: SetupStep; readonly verb: string; readonly subject: string; readonly startedMs: number; narrated: boolean } | undefined;
  /** Time spent starting services and app commands, split out of the summary's `Duration`. */
  private startupMs = 0;
  /** Run-wide model usage, summed from every reported result and serial group. */
  private readonly runUsage = emptyUsage();
  /** The models every reported step named, `provider/id` to call count, for the summary's `AI` row. */
  private readonly runModels: ModelTally = new Map();
  /** The trace cache's part in every reported step, for the summary's `Cache` row. */
  private readonly runCache = emptyCacheTally();
  /**
   * The configured models as the header names them, `provider/id` plus
   * `judge provider/id` when judgments go to a separate model. The summary's
   * `AI` row names the models the steps reported instead, since a custom
   * executor or a pinned agent can answer on another; this label stands in
   * there only when no step named one.
   */
  private models: string | undefined;
  /**
   * The exploration an `e2e explore` run reports through `explore` events;
   * while present, its view stands in for the one synthetic test's file
   * block, live rows, failure entry, and test counters.
   */
  private explore: ExploreView | undefined;
  /** The stream and source of the output line printed last, while nothing else printed since. */
  private lastOutput: string | undefined;
  /**
   * Output not yet ended by a newline, by stream and source: a line written
   * in pieces prints once whole. Flushed when its test's result arrives and
   * when the run ends.
   */
  private readonly pendingOutput = new Map<string, { readonly heading: string; readonly pair: string | undefined; fragment: string }>();

  constructor(
    private readonly output: ListReporterOutput = DEFAULT_OUTPUT,
    options: ListReporterOptions = {},
  ) {
    const live = (options.live ?? process.stdout.isTTY === true) && output.raw !== undefined;
    this.live = live;
    this.pc = picocolors.createColors(options.colors ?? (live || picocolors.isColorSupported));
    this.separator = this.pc.dim(' > ');
    this.tree = new RunningTree(this.pc, (target) => this.badge(target));
    this.window = new LiveWindow(live ? output.raw?.bind(output) : undefined, (room) => this.renderWindow(room));
  }

  onEvent(event: RunEvent): void {
    this.handle(event);
  }

  /**
   * The reporter as an event sink: one dispatch per fact. Bound, so it can be
   * handed to the run's emitter directly.
   */
  readonly handle = (event: RunEventFact): void => {
    switch (event.type) {
      case 'run-started':
        this.runStarted(event);
        break;
      case 'plan':
        this.plan(event);
        break;
      case 'notice':
        if (this.inFlight !== undefined) this.inFlight.narrated = true;
        this.print(`${this.pc.dim('ℹ')} ${bounded(event.message)}`);
        break;
      case 'setup':
        this.setupStep(event);
        break;
      case 'test-started':
        this.testStarted(event);
        break;
      case 'step':
        this.step(event);
        break;
      case 'output':
        this.testOutput(event);
        break;
      case 'test-finished':
        this.testFinished(event.result);
        break;
      case 'serial-group':
        this.serialGroup(event.group);
        break;
      case 'explore':
        this.exploreProgress(event.progress);
        break;
      case 'run-error':
        this.errors.push(event.error);
        break;
      case 'run-interrupted':
        this.runInterrupted(event);
        break;
      case 'run-stopped':
        this.print(
          this.pc.yellow(
            `stopped after ${event.failures} ${event.failures === 1 ? 'failure' : 'failures'} (--max-failures ${event.limit}): the running tests end as interrupted, the rest are skipped`,
          ),
        );
        break;
      case 'run-finished':
        this.runFinished(event);
        break;
    }
  };

  /** Writes one permanent line without disturbing the live window. */
  private print(line: string): void {
    this.lastOutput = undefined;
    this.window.erase();
    this.output.write(line);
    this.window.logged(line);
    this.window.redraw();
  }

  /**
   * Text a test wrote to stdout or stderr, printed above the live window
   * under a `stdout | file › title` heading, as vitest does. Writes that
   * follow one another from the same source share one heading; any other
   * line in between brings it back. A write carries any piece of a line, so
   * only lines a newline has ended print; the rest waits for the next write,
   * the test's result, or the end of the run.
   */
  private testOutput(event: RunEventOf<'output'>): void {
    const pair = event.pair === undefined ? undefined : pairKey(event.pair.testId, event.pair.agent, event.target, event.pair.repeat);
    const running = pair === undefined ? undefined : this.pairs.get(pair);
    const source = running === undefined ? this.badge(event.target) : `${this.badge(running.group.target)} ${bounded(running.group.file)}${this.separator}${running.title}`;
    this.sourcedOutput(event.stream, source, pair, event.text);
  }

  /**
   * Text user code wrote in the runner's own process (the config's top
   * level, a test file's while it is collected, a reporter), printed like a
   * test's output under a `stdout | runner` heading. The runner hands it
   * here already redacted, only while this reporter shows the run.
   */
  processOutput(stream: 'stdout' | 'stderr', text: string): void {
    this.sourcedOutput(stream, this.pc.dim('runner'), undefined, text);
  }

  /** Prints what `processOutput` left unfinished: the runner hands nothing more once the run's events are all dispatched. */
  endProcessOutput(): void {
    this.flushOutput();
  }

  /** Prints the lines `text` ends under the heading of `stream` and `source`, holding the unfinished rest. */
  private sourcedOutput(stream: 'stdout' | 'stderr', source: string, pair: string | undefined, text: string): void {
    const { pc } = this;
    if (text === '') return;
    const key = `${stream}\u0000${source}`;
    let entry = this.pendingOutput.get(key);
    if (entry === undefined) {
      const label = stream === 'stderr' ? pc.yellow(stream) : pc.dim(stream);
      entry = { heading: `${label} ${pc.dim('|')} ${source}`, pair, fragment: '' };
      this.pendingOutput.set(key, entry);
    }
    const lines = (entry.fragment + text).split('\n');
    entry.fragment = lines.pop() ?? '';
    if (entry.fragment === '') this.pendingOutput.delete(key);
    this.printOutput(key, entry.heading, lines);
  }

  /** Prints finished output lines under their heading, unless the heading is the one printed last. */
  private printOutput(key: string, heading: string, lines: readonly string[]): void {
    if (lines.length === 0) return;
    if (this.lastOutput !== key) this.print(heading);
    for (const line of lines) this.print(bounded(line));
    this.lastOutput = key;
  }

  /** Prints the unfinished output of `pair`, or of every source when undefined. */
  private flushOutput(pair?: string): void {
    for (const [key, entry] of this.pendingOutput) {
      if (pair !== undefined && entry.pair !== pair) continue;
      this.pendingOutput.delete(key);
      this.printOutput(key, entry.heading, [entry.fragment]);
    }
  }

  /**
   * A test's title with the agent it ran as, `[buyer]`, when that is not
   * `default`: a test pinned to several agents lists once per agent, and the
   * tag is what tells the lines apart.
   */
  private titledAs(title: string, agent: string, repeat: number): string {
    const bare = `${bounded(title)}${repeat === 0 ? '' : this.pc.dim(repeatSuffix(repeat))}`;
    return agent === 'default' ? bare : `${bare} ${this.pc.dim(`[${bounded(agent)}]`)}`;
  }

  /** A target's colored badge, `|web|` when colors are off (vitest's convention). */
  private badge(target: string): string {
    const name = bounded(target);
    if (!this.pc.isColorSupported) return `|${name}|`;
    const index = Math.max(0, this.targets.indexOf(target));
    const color = BADGE_COLORS[index % BADGE_COLORS.length]!;
    return this.pc.black(this.pc[color](` ${name} `));
  }

  /** A path relative to the project root when inside it, else as given. */
  private displayPath(target: string): string {
    const inside =
      this.projectRoot !== undefined && target.startsWith(`${this.projectRoot}${path.sep}`);
    return bounded(inside ? path.relative(this.projectRoot!, target) : target);
  }

  private group(file: string, target: string): FileGroup {
    const key = `${target}\u0000${file}`;
    let group = this.groups.get(key);
    if (group === undefined) {
      group = { file, target, planned: undefined, lines: [], printed: false };
      this.groups.set(key, group);
    }
    return group;
  }

  private runStarted(event: RunEventOf<'run-started'>): void {
    const { pc } = this;
    this.projectRoot = event.projectRoot;
    this.artifactsRoot = event.artifactsRoot;
    this.targets = event.targets;
    this.launchedAt = new Date();
    const version = packageVersion(import.meta.url, '../../package.json', '0.0.0');
    this.print('');
    this.print(
      `${pc.bold(pc.black(pc.bgCyan(' RUN ')))} ${pc.cyan(`e2e v${version}`)} ${pc.gray(event.projectRoot)}`,
    );
    const details = [`run ${event.runId}`, `targets: ${event.targets.join(', ')}`];
    if (event.agents !== undefined) {
      details.push(`${event.agents.length === 1 ? 'agent' : 'agents'}: ${event.agents.map(bounded).join(', ')}`);
    }
    if (event.ci) details.push('CI');
    this.print(BADGE_PADDING + pc.dim(details.join(' · ')));
    if (event.model !== undefined) {
      this.models = bounded(event.model);
      if (event.judge !== undefined) this.models += ` · judge ${bounded(event.judge)}`;
      this.print(BADGE_PADDING + pc.dim(`model ${this.models}`));
    }
    this.print('');
    this.window.start();
  }

  /**
   * The plan is settled once collection and every target's `prepare` are
   * done, so its arrival is when the run starts executing and the clock
   * starts: a browser downloaded moments earlier is not on it.
   */
  private plan(event: RunEventOf<'plan'>): void {
    this.startedAt = new Date();
    for (const planned of event.files) {
      this.group(planned.file, planned.target).planned = planned.tests;
    }
    this.window.redraw();
  }

  /**
   * The setup stretch before any test: collection, each target's `prepare`,
   * then the services and app commands. Without this the window showed only
   * zero counters while a database booted or a browser downloaded. The step
   * in flight ticks in the live window; a finished process prints once with
   * its wait, a finished collection or provisioning only when it narrated;
   * the process waits sum into the summary's startup split.
   */
  private setupStep(event: RunEventOf<'setup'>): void {
    const { pc } = this;
    const { verb, subject, done } = setupWording(event.step);
    if (event.state === 'started') {
      this.inFlight = { step: event.step, verb, subject, startedMs: Date.now(), narrated: false };
      this.window.redraw();
      return;
    }
    const narrated = this.inFlight?.narrated ?? false;
    this.inFlight = undefined;
    const process = event.step.kind === 'service' || event.step.kind === 'app';
    if (process) this.startupMs += event.durationMs;
    if (!process && !narrated) {
      this.window.redraw();
      return;
    }
    const outcome = event.outcome ?? done;
    this.print(` ${pc.green(F_CHECK)} ${subject} ${pc.dim(`${outcome} ${formatTime(event.durationMs)}`)}`);
  }

  /**
   * Acknowledged immediately, so a bounded teardown is not mistaken for a
   * hang. An interrupt that lands during setup names the step it cut short
   * (`interrupted while starting service "postgres"`), since no test was
   * running to stop.
   */
  private runInterrupted(event: RunEventOf<'run-interrupted'>): void {
    this.interrupted = true;
    const during = this.inFlight === undefined ? undefined : `${this.inFlight.verb} ${this.inFlight.subject}`;
    this.print(
      this.pc.yellow(
        event.mode === 'forced'
          ? 'interrupted again: tearing every worker down now'
          : during === undefined
            ? 'interrupted: stopping the running test and tearing down (interrupt again to force)'
            : `interrupted while ${during}: tearing down (interrupt again to force)`,
      ),
    );
  }

  /**
   * A worker began one test-target pair: show it in the live window. A serial
   * member replaces the previous member of its group, which has finished
   * executing even though its result only arrives with the whole group. A
   * serial group retries as a whole, so a member starts once per group
   * attempt; its steps from earlier attempts stay with it, as an ordinary
   * test's do.
   */
  private testStarted(event: RunEventOf<'test-started'>): void {
    if (event.serialId !== undefined) {
      for (const test of this.pairs.values()) {
        if (test.serialId === event.serialId && test.group.target === event.target) test.executing = false;
      }
    }
    const key = pairKey(event.testId, event.agent, event.target, event.repeat);
    this.pairs.set(key, {
      group: this.group(event.file, event.target),
      serialId: event.serialId,
      title: this.titledAs(event.title, event.agent, event.repeat),
      startedMs: Date.now(),
      executing: true,
      current: undefined,
      steps: this.pairs.get(key)?.steps ?? [],
    });
    this.window.redraw();
  }

  /**
   * Tracks step progress of a running pair. With a live window the pair's
   * finished agent steps accumulate under its row there and print once, nested
   * under its line, when the file block prints - so every name appears exactly
   * once in the scrollback. Without a window (CI logs) nothing is transient, so
   * each finished agent step prints at once, prefixed with its test. Deterministic
   * steps are fast and many, so they only ever show in the live window.
   */
  private step(event: RunEventOf<'step'>): void {
    const running = this.pairs.get(pairKey(event.testId, event.agent, event.target, event.repeat));
    if (running === undefined) return;
    const { progress } = event;
    switch (progress.phase) {
      case 'start': {
        const { api, label, kind } = progress;
        running.current = { api, label, kind, events: [], replaying: false, activity: undefined };
        this.window.redraw();
        break;
      }
      case 'event': {
        const { current } = running;
        this.explore?.action(progress.event);
        if (current === undefined) break;
        // The event ends whatever was announced; until the next announcement
        // the model has the turn.
        const announced = current.activity !== undefined;
        current.activity = undefined;
        const shown = isShownEvent(progress.event);
        if (shown) current.events.push(progress.event);
        if (shown || announced) this.window.redraw();
        break;
      }
      case 'activity': {
        const { current } = running;
        if (current === undefined) break;
        current.activity = progress.activity;
        this.window.redraw();
        break;
      }
      case 'replay': {
        const { current } = running;
        if (current === undefined) break;
        current.replaying = progress.active;
        this.window.redraw();
        break;
      }
      case 'end': {
        running.current = undefined;
        if (progress.kind !== 'agent') {
          this.window.redraw();
          break;
        }
        const { api, label, status, durationMs, modelCalls } = progress;
        const step = { api, label, status, durationMs, modelCalls };
        // An exploration's planner and charter steps show as the exploration's own rows.
        if (this.explore !== undefined) break;
        if (this.live) {
          running.steps.push(step);
          this.window.redraw();
        } else {
          const context = `${this.pc.dim(running.title)}${this.separator}`;
          this.print(`${TEST_INDENT}${stepLine(this.pc, step, { context })}`);
        }
        break;
      }
    }
  }

  /** Holds a serial group until each of its members' results has read its details. */
  private serialGroup(group: SerialGroupRecord): void {
    this.pendingSerial.set(group.id, { group, remaining: group.memberTestIds.length });
  }

  /**
   * The details behind one result. A serial member's come from its group; a
   * group that never arrived (a stream out of contract) leaves them empty
   * rather than failing the run.
   */
  private detailsOf(result: RunEventResult): ResultDetails {
    if (result.serialGroupId === undefined) return attemptDetails(result.attempts);
    const pending = this.pendingSerial.get(result.serialGroupId);
    if (pending === undefined) return attemptDetails([]);
    pending.remaining -= 1;
    if (pending.remaining <= 0) this.pendingSerial.delete(result.serialGroupId);
    return serialMemberDetails(pending.group, result.test.id);
  }

  private testFinished(result: RunEventResult): void {
    // Unselected pairs are report-only: they never print and the plan never
    // counted them.
    if (!result.selected) return;
    const key = pairKey(result.test.id, result.agent, result.target.name, result.repeat);
    this.flushOutput(key);
    const steps = this.pairs.get(key)?.steps ?? [];
    this.pairs.delete(key);
    const group = this.group(result.test.file, result.target.name);
    // Read before `detailsOf` releases the result's serial group.
    const skippedAfter = failureBeforeSkip(result, (id) => this.pendingSerial.get(id)?.group);
    const { durationMs, usage, models, cache, error, videos, failure, screenPath } = this.detailsOf(result);
    addUsage(this.runUsage, usage);
    addModelTally(this.runModels, models);
    addCacheTally(this.runCache, cache);
    const title = this.titledAs(result.test.titlePath.join(' > '), result.agent, result.repeat);
    if (this.explore !== undefined) {
      // The exploration's verdict is its findings; any other error is a failure of its own, unless the run stopped it.
      this.explore.result(result.attempts.flatMap((attempt) => attempt.artifacts));
      if (error !== undefined && result.status !== 'interrupted' && !this.explore.isVerdict(error)) {
        this.failures.push({ group, title, status: result.status, error, videos, failure, screenPath });
      }
      this.window.redraw();
      return;
    }
    const line: TestLine = {
      title,
      declarationIndex: result.test.declarationIndex,
      status: result.status,
      durationMs,
      usage,
      firstErrorLine: error === undefined ? undefined : bounded(error.message).split('\n')[0],
      skipReason: result.skip === undefined ? undefined : bounded(result.skip.reason),
      steps,
    };
    group.lines.push(line);
    this.runs.push({
      key: `${result.test.id}@${result.agent}@${result.target.name}`,
      label: `${this.badge(group.target)} ${bounded(group.file)}${this.separator}${this.titledAs(result.test.titlePath.join(' > '), result.agent, 0)}`,
      // A flaky run's final attempt passed; the code is the one its retry recovered from.
      run: { repeat: result.repeat, status: result.status, code: error?.code ?? result.attempts.findLast((attempt) => attempt.status !== 'passed')?.error?.code },
    });
    if (statusBucket(result.status) === 'failed') {
      this.failures.push({ group, title, status: result.status, error, videos, failure, screenPath });
    }
    if (skippedAfter !== undefined) {
      this.skippedFailures.push({ group, title, status: result.status, error: skippedAfter.error, videos, ...failureOf(skippedAfter) });
    }
    if (group.planned !== undefined && group.lines.length >= group.planned) this.printGroup(group);
    this.window.redraw();
  }

  /** Counters over every reported result; the total is the plan's once it has arrived. */
  private testCounters(): Counters {
    const counters = tally([...this.groups.values()].flatMap((group) => group.lines));
    counters.total = 0;
    for (const group of this.groups.values()) counters.total += group.planned ?? group.lines.length;
    return counters;
  }

  /** Counters over test files; a file lands in an outcome once its block has printed. */
  private fileCounters(): Counters {
    const counters = emptyCounters();
    for (const group of this.groups.values()) {
      counters.total += 1;
      if (group.printed) counters[fileOutcome(tally(group.lines))] += 1;
    }
    return counters;
  }

  /**
   * Prints one file's block: the file line with its counts, then - when the
   * file failed, had a flaky pass, or is the run's only file - one line per
   * test with its finished agent steps nested, as vitest lists tests for a
   * failed module. With a live window the block is also the only permanent
   * record of a file's agent steps, so a file that has any lists its tests
   * too; without one the steps already printed as they finished.
   */
  private printGroup(group: FileGroup): void {
    if (group.printed) return;
    group.printed = true;
    const { pc } = this;
    const counts = tally(group.lines);
    const outcome = fileOutcome(counts);
    const symbol =
      outcome === 'failed'
        ? pc.red(F_POINTER)
        : outcome === 'interrupted'
          ? pc.yellow(F_POINTER)
          : outcome === 'skipped'
            ? pc.dim(pc.gray(F_DOWN))
            : pc.green(F_CHECK);
    const state = [
      pc.dim(`${counts.total} test${counts.total === 1 ? '' : 's'}`),
      counts.failed > 0 ? pc.red(`${counts.failed} failed`) : undefined,
      counts.interrupted > 0 ? pc.yellow(`${counts.interrupted} interrupted`) : undefined,
      counts.flaky > 0 ? pc.yellow(`${counts.flaky} flaky`) : undefined,
      counts.skipped > 0 ? pc.yellow(`${counts.skipped} skipped`) : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(pc.dim(' | '));
    const durationMs = group.lines.reduce((total, line) => total + line.durationMs, 0);
    const ai = aiSegment(sumUsage(group.lines));
    const parts = [
      ` ${symbol} ${this.badge(group.target)} ${bounded(group.file)}`,
      `${pc.dim('(')}${state}${pc.dim(')')}`,
    ];
    // A file whose tests all skipped never ran; `0ms` would only invite a question.
    if (durationMs > 0) parts.push(pc.dim(formatTime(durationMs)));
    if (ai !== undefined) parts.push(pc.dim(ai));
    this.print(parts.join(' '));
    const verbose =
      counts.failed > 0 ||
      counts.interrupted > 0 ||
      counts.flaky > 0 ||
      this.groups.size === 1 ||
      (this.live && group.lines.some((line) => line.steps.length > 0));
    if (!verbose) return;
    const ordered = group.lines.toSorted((a, b) => a.declarationIndex - b.declarationIndex);
    for (const line of ordered) {
      for (const rendered of this.testLine(line)) this.print(rendered);
      for (const step of line.steps) this.print(`${STEP_INDENT}${stepLine(pc, step)}`);
    }
  }

  /** One test row under its file line, plus the first error line for a failure. */
  private testLine(line: TestLine): string[] {
    const { pc } = this;
    const duration = pc.dim(formatTime(line.durationMs));
    const segment = aiSegment(line.usage);
    const ai = segment === undefined ? '' : ` ${pc.dim(segment)}`;
    switch (line.status) {
      case 'passed':
        return [`   ${pc.green(F_CHECK)} ${line.title} ${duration}${ai}`];
      case 'flaky':
        return [`   ${pc.yellow(F_CHECK)} ${line.title} ${pc.yellow('(flaky)')} ${duration}${ai}`];
      case 'skipped': {
        // `test.skip` without a message records the bare word; repeating it adds nothing.
        const reason =
          line.skipReason === undefined || line.skipReason === 'skipped'
            ? ''
            : pc.dim(pc.gray(` [${line.skipReason}]`));
        return [`   ${pc.dim(pc.gray(F_DOWN))} ${line.title}${reason}`];
      }
      case 'interrupted':
        return [`   ${pc.yellow(F_CROSS)} ${line.title} ${pc.yellow('(interrupted)')} ${duration}${ai}`];
      default: {
        const status = line.status === 'failed' ? '' : pc.red(` (${line.status})`);
        const rows = [`   ${pc.red(`${F_CROSS} ${line.title}`)}${status} ${duration}${ai}`];
        if (line.firstErrorLine !== undefined) {
          // A glance line; the `Failed Tests` section carries the whole message.
          const glance = fitColumns(line.firstErrorLine, terminalColumns() - ERROR_GLANCE_INDENT);
          rows.push(`     ${pc.red(`${F_RIGHT} ${glance}`)}`);
        }
        return rows;
      }
    }
  }

  /**
   * vitest's padded summary, shared by the live window and the final report:
   * files, tests, model usage, the trace cache's part, run errors, start
   * time, and elapsed time. The
   * clock rows wait for `plan`; the final summary of a run that never got
   * there (a config or collection failure, a failed download) counts from
   * the launch instead, so the time it took to fail is still on record.
   */
  private summaryRows(final: boolean): string[] {
    const { pc } = this;
    const files = this.fileCounters();
    const tests = this.testCounters();
    const rows =
      this.explore?.summaryRows() ?? [
        padTitle(pc, 'Test Files') + (files.total === 0 ? this.emptyState('no test files', 'none started') : stateString(pc, files)),
        padTitle(pc, 'Tests') + (tests.total === 0 ? this.emptyState('no tests executed', 'none executed') : stateString(pc, tests)),
      ];
    const ai = usageText(this.runUsage);
    if (ai !== undefined) {
      const models = modelsText(this.runModels) ?? this.models;
      rows.push(padTitle(pc, 'AI') + `${ai} · ${this.runUsage.calls} model calls${models === undefined ? '' : ` · ${models}`}`);
    }
    const cache = cacheText(pc, this.runCache);
    if (cache !== undefined) rows.push(padTitle(pc, 'Cache') + cache);
    if (final) rows.push(...this.repeatRows());
    if (this.skippedFailures.length > 0) {
      rows.push(padTitle(pc, 'Warnings') + pc.yellow(`${this.skippedFailures.length} skipped after failure`));
    }
    if (this.errors.length > 0) {
      const count = this.errors.length;
      rows.push(padTitle(pc, 'Errors') + pc.bold(pc.red(`${count} error${count === 1 ? '' : 's'}`)));
    }
    const startedAt = this.startedAt ?? (final ? this.launchedAt : undefined);
    if (startedAt !== undefined) {
      rows.push(padTitle(pc, 'Start at') + formatClock(startedAt));
      rows.push(padTitle(pc, 'Duration') + durationText(pc, Date.now() - startedAt.getTime(), this.startupMs));
    }
    return rows;
  }

  /**
   * The `Repeats` row of a `--repeat-each` run: how many tests passed every
   * run, then one line per test that did not, naming the runs that failed.
   */
  private repeatRows(): string[] {
    const { pc } = this;
    const groups = repeatGroups(this.runs, (entry) => entry);
    if (groups.length === 0) return [];
    // A test is listed when it missed a run: a flake first, then one the run cut short.
    const missed = groups.filter((group) => group.passed < group.runs.length).toSorted((a, b) => Number(b.unstable) - Number(a.unstable));
    const summary = repeatSummary(groups);
    return [
      padTitle(pc, 'Repeats') + (missed.some((group) => group.unstable) ? pc.yellow(summary) : pc.green(summary)),
      ...missed.map((group) => `${padTitle(pc, '')}${group.unstable ? pc.yellow(F_CROSS) : pc.dim(pc.gray(F_DOWN))} ${group.label}  ${pc.dim(repeatLine(group))}`),
    ];
  }

  /** A zero counter's label: the plain text, or the interrupt when that is why nothing is counted. */
  private emptyState(none: string, cut: string): string {
    const { pc } = this;
    return this.interrupted ? pc.yellow(`${cut} (interrupted)`) : pc.dim(none);
  }

  /** The live window: the running tree, then the summary. */
  /** The block's rows for `room` screen rows under the permanent log. */
  private renderWindow(room: number): string[] {
    const running = [...this.pairs.values()].filter((test) => test.executing);
    if (this.explore !== undefined) {
      return this.explore.liveRows(this.exploreBadge(), running[0]?.current?.events, this.summaryRows(false), Date.now(), room);
    }
    return this.tree.render(running, this.summaryRows(false), Date.now(), room, this.inFlight);
  }

  /** The badge of the explored target: an exploration runs on exactly one. */
  private exploreBadge(): string {
    return this.badge(this.targets[0] ?? '');
  }

  /**
   * One moment of an exploration. The first creates the view and, without a
   * live window, prints the header; from then on a finished step and a
   * finding each print at once without one, and the window shows them with
   * one.
   */
  private exploreProgress(progress: RunEventOf<'explore'>['progress']): void {
    if (progress.phase === 'started') {
      this.explore = new ExploreView(this.pc, progress);
      if (!this.live) {
        this.print(this.explore.header(this.exploreBadge(), 'Exploring'));
      }
      this.window.redraw();
      return;
    }
    const view = this.explore;
    if (view === undefined) return;
    view.progress(progress);
    if (!this.live) {
      if (progress.phase === 'step-finished' && view.lastStep !== undefined) {
        for (const line of view.stepLines(view.lastStep)) this.print(line);
      } else if (progress.phase === 'finding') {
        this.print(view.findingLine(progress.finding));
      }
    }
    this.window.redraw();
  }

  /**
   * An exploration's permanent record: the header and, with a live window,
   * the steps it was the only home of; then the findings with their
   * evidence, and the closing assessment.
   */
  private printExplore(): void {
    const view = this.explore;
    if (view === undefined) return;
    for (const line of view.record(this.exploreBadge(), this.live)) this.print(line);
    for (const line of view.findingsSection((target) => this.displayPath(target), this.artifactsRoot)) this.print(line);
    for (const line of view.assessment()) this.print(line);
  }

  /** vitest's `Failed Tests` section: a banner, then each failure with its code frame. */
  private printFailures(heading: string, failures: readonly Failure[]): void {
    const { pc } = this;
    if (failures.length === 0) return;
    this.print('');
    this.print(this.errorBanner(`${heading} ${failures.length}`));
    this.print('');
    failures.forEach(({ group, title, status, error, videos, failure, screenPath }, index) => {
      this.print(
        `${pc.bold(pc.bgRed(status === 'skipped' ? ' SKIP ' : ' FAIL '))} ${this.badge(group.target)} ${bounded(group.file)}${this.separator}${title}`,
      );
      if (error === undefined) {
        this.print(pc.red(`${pc.bold(status)}: no error was recorded`));
      } else {
        const [first = '', ...rest] = bounded(error.message).split('\n');
        this.print(pc.red(`${pc.bold(bounded(error.code))}: ${first}`));
        for (const line of rest) this.print(pc.red(line));
        this.printFailureLocation(error.stack);
      }
      this.printEvidence(failure, screenPath);
      this.printVideos(videos);
      const marker = `[${index + 1}/${failures.length}]`;
      const { before, after } = rule(marker, 'right');
      this.print('');
      this.print(pc.red(pc.dim(`${before}${marker}${after}`)));
      this.print('');
    });
  }

  /** A full-width red rule with a centered `FAIL`-style label. */
  private errorBanner(message: string): string {
    const { pc } = this;
    const label = pc.bold(pc.bgRed(` ${message} `));
    const { before, after } = rule(label, 'center');
    return `${pc.red(before)}${label}${pc.red(after)}`;
  }

  /**
   * What the runner saw when the failure landed: the location, the nodes
   * closest to what a failed locator asked for, and where the screen text
   * is. The message says what was asked; these lines say what was there.
   */
  private printEvidence(failure: FailureEvidence | undefined, screenPath: string | undefined): void {
    if (failure === undefined) return;
    const { pc } = this;
    const row = (label: string, text: string): void => {
      this.print(pc.cyan(` ${pc.dim(F_POINTER)} ${pc.dim(label)} ${text}`));
    };
    if (failure.url !== undefined) row('at', bounded(failure.url));
    for (const candidate of failure.candidates ?? []) row('on screen', bounded(candidate));
    if (screenPath !== undefined) {
      const target = this.artifactsRoot === undefined ? screenPath : path.join(this.artifactsRoot, screenPath);
      row('screen', this.displayPath(target));
    }
  }

  /** Where to watch a failed attempt: one line per recording it kept. */
  private printVideos(videos: readonly string[]): void {
    const { pc } = this;
    for (const video of videos) {
      const hosted = /^https?:\/\//.test(video);
      const target = hosted || this.artifactsRoot === undefined ? video : path.join(this.artifactsRoot, video);
      this.print(pc.cyan(` ${pc.dim(F_POINTER)} ${pc.dim('video')} ${hosted ? bounded(video) : this.displayPath(target)}`));
    }
  }

  /** Names the user's failing line and renders a code frame around it. */
  private printFailureLocation(stack: string | undefined): void {
    const { pc } = this;
    const frame = userFrame(stack, this.projectRoot);
    if (frame === undefined) return;
    this.print(
      pc.cyan(` ${pc.dim(F_POINTER)} ${bounded(this.displayPath(frame.file))}:${pc.dim(`${frame.line}:${frame.column}`)}`),
    );
    for (const line of codeFrame(frame, pc)) this.print(`    ${line}`);
  }

  /**
   * Run-level errors never arrive as results: they abort before, between, or
   * after test execution. Without this the console shows only a bare exit
   * code and the reason lives solely in report.json.
   */
  private printErrors(): void {
    const { pc } = this;
    if (this.errors.length === 0) return;
    this.print('');
    this.print(this.errorBanner(`Run Errors ${this.errors.length}`));
    this.print('');
    for (const error of this.errors) {
      const phase = error.phase === undefined ? '' : pc.dim(` (${bounded(error.phase)})`);
      this.print(
        `${pc.bold(pc.bgRed(' ERROR '))} ${bounded(error.category)} error ${pc.dim(bounded(error.code))}${phase}`,
      );
      for (const line of bounded(error.message).split('\n')) this.print(pc.red(line));
      this.print('');
    }
  }

  /** Prints the rows reporters resolved with under the summary, in the summary's layout. */
  rows(rows: ReporterSummary): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      this.print(padTitle(this.pc, bounded(row.label)) + bounded(row.text));
    }
    this.print('');
  }

  private runFinished(event: RunEventOf<'run-finished'>): void {
    const { pc } = this;
    if (event.status === 'interrupted') this.interrupted = true;
    this.window.stop();
    this.flushOutput();
    // An interrupted or crashed run leaves files without their full result
    // set; print what they have so nothing that ran goes unreported.
    for (const group of this.groups.values()) {
      if (!group.printed && group.lines.length > 0) this.printGroup(group);
    }
    this.printExplore();
    this.printFailures('Failed Tests', this.failures);
    this.printFailures('Skipped After Failure', this.skippedFailures);
    this.printErrors();
    this.print('');
    for (const row of this.summaryRows(true)) this.print(row);
    this.print(
      padTitle(pc, 'Report') +
        (event.reportPath === undefined ? pc.dim('(not written)') : this.displayPath(event.reportPath)),
    );
    if (event.aiTracePath !== undefined) {
      const shown = this.displayPath(event.aiTracePath);
      this.print(padTitle(pc, 'AI trace') + `${shown} ${pc.dim(`(open with: npx unbox-ai ${shown})`)}`);
    }
    this.print('');
  }
}


/**
 * How the reporter phrases one setup step: the verb and subject while it
 * runs (`starting service "postgres"`), and the word for its completion
 * (`ready`); a reused process says `reused` instead.
 */
function setupWording(step: SetupStep): { verb: string; subject: string; done: string } {
  switch (step.kind) {
    case 'collect':
      return { verb: 'collecting', subject: 'tests', done: 'collected' };
    case 'prepare':
      return {
        verb: 'preparing',
        subject: `${bounded(step.engine)} engine for target "${bounded(step.target)}"`,
        done: 'prepared',
      };
    case 'service':
    case 'app':
      return { verb: 'starting', subject: bounded(step.label), done: 'ready' };
  }
}
