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
import type { ArtifactRecord, AttemptRecord, ResultStatus, SerialGroupRecord } from '../run/records.ts';
import type { Reporter, ReporterSummary } from '../types.ts';
import { codeFrame, userFrame } from './code-frame.ts';
import {
  addCacheTally,
  addUsage,
  aiSegment,
  bounded,
  cacheText,
  ellipsize,
  emptyCacheTally,
  emptyCounters,
  emptyUsage,
  F_CHECK,
  F_CROSS,
  F_POINTER,
  fileOutcome,
  formatClock,
  formatTime,
  padTitle,
  rule,
  stateString,
  statusBucket,
  stepsCacheTally,
  stepsUsage,
  sumUsage,
  tally,
  terminalColumns,
  usageText,
  type AiUsage,
  type CacheTally,
  type Colors,
  type Counters,
} from './format.ts';
import { isShownEvent, type FileGroup, type RunningTest, type TestLine } from './list-model.ts';
import { stepLine } from './list-steps.ts';
import { LiveWindow } from './live-window.ts';
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
 * a test runs once per agent it is pinned to, on each target.
 */
function pairKey(testId: string, agent: string, target: string): string {
  return `${testId}@${agent}@${target}`;
}

/** What a test line and a failure entry need from a result's execution. */
interface ResultDetails {
  readonly durationMs: number;
  readonly usage: AiUsage;
  readonly cache: CacheTally;
  readonly error: SerializedError | undefined;
  /** Report-relative paths of the recordings the attempts kept, in attempt order. */
  readonly videos: readonly string[];
}

/** Details of an ordinary result: summed over its attempts, the error from the last. */
function attemptDetails(attempts: readonly AttemptRecord[]): ResultDetails {
  return {
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    usage: stepsUsage(attempts.map((attempt) => attempt.steps)),
    cache: stepsCacheTally(attempts.map((attempt) => attempt.steps)),
    error: attempts[attempts.length - 1]?.error,
    videos: videoPaths(attempts),
  };
}

/** Report-relative paths of the video artifacts these attempts kept, in order. */
function videoPaths(attempts: readonly { readonly artifacts: readonly ArtifactRecord[] }[]): string[] {
  const paths: string[] = [];
  for (const attempt of attempts) {
    for (const artifact of attempt.artifacts) {
      if (artifact.kind === 'video' && artifact.path !== undefined) paths.push(artifact.path);
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
  const last = runs[runs.length - 1];
  const own = last?.member;
  const neverRan = own === undefined || own.status === 'skipped';
  return {
    durationMs: runs.reduce((total, run) => total + (run.member?.durationMs ?? 0), 0),
    usage: stepsUsage(runs.map((run) => run.member?.steps ?? [])),
    cache: stepsCacheTally(runs.map((run) => run.member?.steps ?? [])),
    error: own?.error ?? (neverRan ? last?.attempt.error : undefined),
    // The group's recording covers every member, so a failed member points at it.
    videos: videoPaths(group.attempts),
  };
}

/** One failed pair, held for the `Failed Tests` section. */
interface Failure {
  readonly group: FileGroup;
  readonly title: string;
  readonly status: ResultStatus;
  readonly error: SerializedError | undefined;
  /** Report-relative paths of the recordings the failed attempts kept, if any. */
  readonly videos: readonly string[];
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
  /** The trace cache's part in every reported step, for the summary's `Cache` row. */
  private readonly runCache = emptyCacheTally();
  /**
   * The configured models as the summary names them, `provider/id` plus
   * `vision provider/id` when pixels go to a separate model: `runUsage` sums
   * both, so the row names both. Repeated in the summary because the header
   * has scrolled away by the time a long run ends.
   */
  private models: string | undefined;

  constructor(
    private readonly output: ListReporterOutput = DEFAULT_OUTPUT,
    options: ListReporterOptions = {},
  ) {
    const live = (options.live ?? process.stdout.isTTY === true) && output.raw !== undefined;
    this.live = live;
    this.pc = picocolors.createColors(options.colors ?? (live || picocolors.isColorSupported));
    this.separator = this.pc.dim(' > ');
    this.tree = new RunningTree(this.pc, (target) => this.badge(target));
    this.window = new LiveWindow(live ? output.raw?.bind(output) : undefined, () => this.renderWindow());
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
      case 'test-finished':
        this.testFinished(event.result);
        break;
      case 'serial-group':
        this.serialGroup(event.group);
        break;
      case 'run-error':
        this.errors.push(event.error);
        break;
      case 'run-interrupted':
        this.runInterrupted(event);
        break;
      case 'run-finished':
        this.runFinished(event);
        break;
    }
  };

  /** Writes one permanent line without disturbing the live window. */
  private print(line: string): void {
    this.window.erase();
    this.output.write(line);
    this.window.redraw();
  }

  /**
   * A test's title with the agent it ran as, `[buyer]`, when that is not
   * `default`: a test pinned to several agents lists once per agent, and the
   * tag is what tells the lines apart.
   */
  private titledAs(title: string, agent: string): string {
    const bare = bounded(title);
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
    this.output.write('');
    this.output.write(
      `${pc.bold(pc.black(pc.bgCyan(' RUN ')))} ${pc.cyan(`e2e v${version}`)} ${pc.gray(event.projectRoot)}`,
    );
    const details = [`run ${event.runId}`, `targets: ${event.targets.join(', ')}`];
    if (event.agents !== undefined) {
      details.push(`${event.agents.length === 1 ? 'agent' : 'agents'}: ${event.agents.map(bounded).join(', ')}`);
    }
    if (event.ci) details.push('CI');
    this.output.write(BADGE_PADDING + pc.dim(details.join(' · ')));
    if (event.model !== undefined) {
      const vision = event.visionModel === undefined ? '' : ` · vision ${bounded(event.visionModel)}`;
      this.models = `${bounded(event.model)}${vision}`;
      this.output.write(BADGE_PADDING + pc.dim(`model ${this.models}`));
    }
    this.output.write('');
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
    const key = pairKey(event.testId, event.agent, event.target);
    this.pairs.set(key, {
      group: this.group(event.file, event.target),
      serialId: event.serialId,
      title: this.titledAs(event.title, event.agent),
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
    const running = this.pairs.get(pairKey(event.testId, event.agent, event.target));
    if (running === undefined) return;
    const { progress } = event;
    switch (progress.phase) {
      case 'start': {
        const { api, label, kind } = progress;
        running.current = { api, label, kind, events: [], replaying: false };
        this.window.redraw();
        break;
      }
      case 'event': {
        const { current } = running;
        if (current === undefined || !isShownEvent(progress.event)) break;
        current.events.push(progress.event);
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
    const key = pairKey(result.test.id, result.agent, result.target.name);
    const steps = this.pairs.get(key)?.steps ?? [];
    this.pairs.delete(key);
    const group = this.group(result.test.file, result.target.name);
    const { durationMs, usage, cache, error, videos } = this.detailsOf(result);
    addUsage(this.runUsage, usage);
    addCacheTally(this.runCache, cache);
    const title = this.titledAs(result.test.titlePath.join(' > '), result.agent);
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
    if (statusBucket(result.status) === 'failed') {
      this.failures.push({ group, title, status: result.status, error, videos });
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
        : outcome === 'skipped'
          ? pc.dim(pc.gray(F_DOWN))
          : pc.green(F_CHECK);
    const state = [
      pc.dim(`${counts.total} test${counts.total === 1 ? '' : 's'}`),
      counts.failed > 0 ? pc.red(`${counts.failed} failed`) : undefined,
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
      default: {
        const status = line.status === 'failed' ? '' : pc.red(` (${line.status})`);
        const rows = [`   ${pc.red(`${F_CROSS} ${line.title}`)}${status} ${duration}${ai}`];
        if (line.firstErrorLine !== undefined) {
          // A glance line; the `Failed Tests` section carries the whole message.
          const glance = ellipsize(line.firstErrorLine, terminalColumns() - ERROR_GLANCE_INDENT);
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
    const rows = [
      padTitle(pc, 'Test Files') + (files.total === 0 ? this.emptyState('no test files', 'none started') : stateString(pc, files)),
      padTitle(pc, 'Tests') + (tests.total === 0 ? this.emptyState('no tests executed', 'none executed') : stateString(pc, tests)),
    ];
    const ai = usageText(this.runUsage);
    if (ai !== undefined) {
      const models = this.models === undefined ? '' : ` · ${this.models}`;
      rows.push(padTitle(pc, 'AI') + `${ai} · ${this.runUsage.calls} model calls${models}`);
    }
    const cache = cacheText(pc, this.runCache);
    if (cache !== undefined) rows.push(padTitle(pc, 'Cache') + cache);
    if (this.errors.length > 0) {
      const count = this.errors.length;
      rows.push(padTitle(pc, 'Errors') + pc.bold(pc.red(`${count} error${count === 1 ? '' : 's'}`)));
    }
    const startedAt = this.startedAt ?? (final ? this.launchedAt : undefined);
    if (startedAt !== undefined) {
      rows.push(padTitle(pc, 'Start at') + formatClock(startedAt));
      const startup = this.startupMs > 0 ? pc.dim(` (startup ${formatTime(this.startupMs)})`) : '';
      rows.push(padTitle(pc, 'Duration') + formatTime(Date.now() - startedAt.getTime()) + startup);
    }
    return rows;
  }

  /** A zero counter's label: the plain text, or the interrupt when that is why nothing is counted. */
  private emptyState(none: string, cut: string): string {
    const { pc } = this;
    return this.interrupted ? pc.yellow(`${cut} (interrupted)`) : pc.dim(none);
  }

  /** The live window: the running tree, then the summary. */
  private renderWindow(): string[] {
    const running = [...this.pairs.values()].filter((test) => test.executing);
    return this.tree.render(running, this.summaryRows(false), Date.now(), this.inFlight);
  }

  /** vitest's `Failed Tests` section: a banner, then each failure with its code frame. */
  private printFailures(): void {
    const { pc } = this;
    if (this.failures.length === 0) return;
    this.print('');
    this.print(this.errorBanner(`Failed Tests ${this.failures.length}`));
    this.print('');
    this.failures.forEach(({ group, title, status, error, videos }, index) => {
      this.print(
        `${pc.bold(pc.bgRed(' FAIL '))} ${this.badge(group.target)} ${bounded(group.file)}${this.separator}${title}`,
      );
      if (error === undefined) {
        this.print(pc.red(`${pc.bold(status)}: no error was recorded`));
      } else {
        const [first = '', ...rest] = bounded(error.message).split('\n');
        this.print(pc.red(`${pc.bold(bounded(error.code))}: ${first}`));
        for (const line of rest) this.print(pc.red(line));
        this.printFailureLocation(error.stack);
      }
      this.printVideos(videos);
      const marker = `[${index + 1}/${this.failures.length}]`;
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

  /** Where to watch a failed attempt: one line per recording it kept. */
  private printVideos(videos: readonly string[]): void {
    const { pc } = this;
    for (const video of videos) {
      const target = this.artifactsRoot === undefined ? video : path.join(this.artifactsRoot, video);
      this.print(pc.cyan(` ${pc.dim(F_POINTER)} ${pc.dim('video')} ${this.displayPath(target)}`));
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
    // An interrupted or crashed run leaves files without their full result
    // set; print what they have so nothing that ran goes unreported.
    for (const group of this.groups.values()) {
      if (!group.printed && group.lines.length > 0) this.printGroup(group);
    }
    this.printFailures();
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
