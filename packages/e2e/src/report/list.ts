/**
 * Human-readable list reporter (spec 06-cli.md), styled after vitest's
 * default reporter: one block per test file and target, a `Failed Tests`
 * section with code frames, and a padded summary. On a TTY a live window
 * below the log shows the running files, their tests, and the counters.
 */

import path from 'node:path';
import picocolors from 'picocolors';
import { sanitizeText, truncateUtf8, type SerializedError } from '../internal/errors.ts';
import { packageVersion } from '../internal/package-version.ts';
import { collapseText } from '../internal/text.ts';
import type { RunEventFact, RunEventOf, RunEventResult } from '../run/events.ts';
import type { AttemptRecord, ResultStatus, SerialGroupRecord } from '../run/records.ts';
import type { StepEvent } from '../run/steps.ts';
import { codeFrame, userFrame } from './code-frame.ts';
import {
  addUsage,
  aiSegment,
  bounded,
  ellipsize,
  emptyCounters,
  emptyUsage,
  fileOutcome,
  formatClock,
  formatTime,
  formatTokens,
  padTitle,
  rule,
  stateString,
  statusBucket,
  stepsUsage,
  sumUsage,
  tally,
  terminalColumns,
  terminalRows,
  type AiUsage,
  type Colors,
  type Counters,
} from './format.ts';
import { LiveWindow } from './live-window.ts';

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_BYTES = 72;

const F_POINTER = '❯';
const F_CHECK = '✓';
const F_CROSS = '×';
const F_DOWN = '↓';
const F_RIGHT = '→';
const F_DOWN_RIGHT = '↳';
const F_TREE_MIDDLE = '├──';
const F_TREE_END = '└──';

/** Indentation under a badge line, matching vitest's banner padding. */
const BADGE_PADDING = '      ';

/** Badge backgrounds, assigned to targets in declaration order. */
const BADGE_COLORS = ['bgYellow', 'bgCyan', 'bgGreen', 'bgMagenta'] as const;

/**
 * Rows the live window spends outside the running tests and the summary: its
 * blank lines, the `… more running` marker, and a margin above the prompt.
 */
const WINDOW_CHROME_ROWS = 6;
/** Rows one running test takes before its calls: the test line and its current step. */
const WINDOW_ROWS_PER_TEST = 2;
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

/** One-line, quoted step label bounded for the live view. */
function stepLabel(label: string): string {
  const flat = collapseText(label);
  const shown = truncateUtf8(flat, MAX_STEP_LABEL_BYTES);
  return `"${shown}${shown === flat ? '' : '…'}"`;
}

/**
 * Live tail for one step event. Model and engine calls are the ones worth a
 * glance (`tool:` prefixes come from executor tool accounting); polls and
 * policy decisions stay quiet.
 */
function eventTail(event: StepEvent): string | undefined {
  if (event.kind === 'model') {
    const tokens =
      event.count !== undefined && event.count > 0 ? ` · ${formatTokens(event.count)} tokens` : '';
    return `model turn ${formatTime(event.durationMs)}${tokens}`;
  }
  if (event.kind === 'engine') {
    const name = sanitizeText(event.name ?? 'engine').replace(/^tool:/, '');
    const failed = event.status === 'passed' ? '' : ` ${F_CROSS}`;
    return `${truncateUtf8(name, 40)} ${formatTime(event.durationMs)}${failed}`;
  }
  return undefined;
}

/** The identity of one test-target pair across `test-started`, `step`, and `test-finished`. */
function pairKey(testId: string, target: string): string {
  return `${testId}@${target}`;
}

/** What a test line and a failure entry need from a result's execution. */
interface ResultDetails {
  readonly durationMs: number;
  readonly usage: AiUsage;
  readonly error: SerializedError | undefined;
}

/** Details of an ordinary result: summed over its attempts, the error from the last. */
function attemptDetails(attempts: readonly AttemptRecord[]): ResultDetails {
  return {
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    usage: stepsUsage(attempts.map((attempt) => attempt.steps)),
    error: attempts[attempts.length - 1]?.error,
  };
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
    error: own?.error ?? (neverRan ? last?.attempt.error : undefined),
  };
}

/** A pair that is executing right now, shown in the live window. */
interface RunningTest {
  readonly group: FileGroup;
  /** The pair's serial group, when it belongs to one. */
  readonly serialId: string | undefined;
  readonly title: string;
  readonly startedMs: number;
  /** Current step, `api "label"`, while one is executing. */
  step: string | undefined;
  /** Model and engine calls of the current step, oldest first. */
  events: string[];
  /** Whether this pair's story streams permanently above the window. */
  streaming: boolean;
}

/** One finished pair, held until its file's block prints. */
interface TestLine {
  readonly title: string;
  /** Source order within the file; blocks list tests as declared, not as finished. */
  readonly declarationIndex: number;
  readonly status: ResultStatus;
  readonly durationMs: number;
  readonly usage: AiUsage;
  readonly firstErrorLine: string | undefined;
  readonly skipReason: string | undefined;
}

/**
 * Every pair of one test file on one target: vitest's "test module". Its
 * block prints once all planned results are in, so files never interleave.
 * Counts, durations, and usage derive from `lines`, so there is one source.
 */
interface FileGroup {
  readonly file: string;
  readonly target: string;
  /** Reportable pairs the plan announced; undefined until the plan arrives. */
  planned: number | undefined;
  readonly lines: TestLine[];
  /** A pair of this file streamed its steps permanently, so list every test. */
  streamed: boolean;
  printed: boolean;
}

/** One failed pair, held for the `Failed Tests` section. */
interface Failure {
  readonly group: FileGroup;
  readonly title: string;
  readonly status: ResultStatus;
  readonly error: SerializedError | undefined;
}

const DEFAULT_OUTPUT: ListReporterOutput = {
  write: (line) => process.stdout.write(`${line}\n`),
  raw: (text) => process.stdout.write(text),
};

/**
 * Renders the run's event stream as the CLI's human-readable output. The
 * reporter is one sink on the run's single event spine, beside a host's
 * `onEvent`, so the CLI shows exactly what a host receives.
 */
export class ListReporter {
  private readonly pc: Colors;
  private readonly window: LiveWindow;
  private readonly separator: string;
  private projectRoot: string | undefined;
  /** Selected targets in declaration order; decides each badge's color. */
  private targets: readonly string[] = [];
  /** When the run began: the summary's `Start at` and the origin of `Duration`. */
  private startedAt = new Date();
  /** File groups keyed `${target}\u0000${file}`, in first-seen order. */
  private readonly groups = new Map<string, FileGroup>();
  /** Pairs executing right now, keyed by `pairKey`, in start order. */
  private readonly running = new Map<string, RunningTest>();
  private readonly failures: Failure[] = [];
  /**
   * Serial groups whose members' results are still to come, by group id. The
   * runner emits a group before its member results, and a member's details
   * live only in the group.
   */
  private readonly pendingSerial = new Map<string, { group: SerialGroupRecord; remaining: number }>();
  /** Run-level errors, printed once at the end; the stream carries them as they happen. */
  private readonly errors: SerializedError[] = [];
  /** Run-wide model usage, summed from every reported result and serial group. */
  private readonly runUsage = emptyUsage();

  constructor(
    private readonly output: ListReporterOutput = DEFAULT_OUTPUT,
    options: ListReporterOptions = {},
  ) {
    const live = (options.live ?? process.stdout.isTTY === true) && output.raw !== undefined;
    this.pc = picocolors.createColors(options.colors ?? (live || picocolors.isColorSupported));
    this.separator = this.pc.dim(' > ');
    this.window = new LiveWindow(live ? output.raw?.bind(output) : undefined, () => this.renderWindow());
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
        this.print(`${this.pc.dim('ℹ')} ${bounded(event.message)}`);
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
      group = { file, target, planned: undefined, lines: [], streamed: false, printed: false };
      this.groups.set(key, group);
    }
    return group;
  }

  private runStarted(event: RunEventOf<'run-started'>): void {
    const { pc } = this;
    this.projectRoot = event.projectRoot;
    this.targets = event.targets;
    this.startedAt = new Date();
    const version = packageVersion(import.meta.url, '../../package.json', '0.0.0');
    this.output.write('');
    this.output.write(
      `${pc.bold(pc.black(pc.bgCyan(' RUN ')))} ${pc.cyan(`e2e v${version}`)} ${pc.gray(event.projectRoot)}`,
    );
    const details = [`run ${event.runId}`, `targets: ${event.targets.join(', ')}`];
    if (event.ci) details.push('CI');
    this.output.write(BADGE_PADDING + pc.dim(details.join(' · ')));
    this.output.write('');
    this.window.start();
  }

  private plan(event: RunEventOf<'plan'>): void {
    for (const planned of event.files) {
      this.group(planned.file, planned.target).planned = planned.tests;
    }
    this.window.redraw();
  }

  /** Acknowledged immediately, so a bounded teardown is not mistaken for a hang. */
  private runInterrupted(event: RunEventOf<'run-interrupted'>): void {
    this.print(
      this.pc.yellow(
        event.mode === 'graceful'
          ? 'interrupted: stopping the running test and tearing down (interrupt again to force)'
          : 'interrupted again: tearing every worker down now',
      ),
    );
  }

  /**
   * A worker began one test-target pair: show it in the live window. A serial
   * member replaces the previous member of its group, which has finished
   * executing even though its result only arrives with the whole group.
   */
  private testStarted(event: RunEventOf<'test-started'>): void {
    if (event.serialId !== undefined) {
      for (const [key, test] of this.running) {
        if (test.serialId === event.serialId && test.group.target === event.target) {
          this.running.delete(key);
        }
      }
    }
    this.running.set(pairKey(event.testId, event.target), {
      group: this.group(event.file, event.target),
      serialId: event.serialId,
      title: bounded(event.title),
      startedMs: Date.now(),
      step: undefined,
      events: [],
      streaming: false,
    });
    this.window.redraw();
  }

  /**
   * Streams step progress of a running pair. With a single test running, its
   * agent steps print permanently and chronologically under a header naming
   * the file and test - the scrollback of a long agentic run reads without
   * `--debug`. Deterministic steps are fast and many, so they only ever show
   * in the live window. With parallel tests the stream would interleave, so
   * each pair instead shows its current step and latest calls transiently in
   * the live window, and finished agent steps print with the test they
   * belong to.
   */
  private step(event: RunEventOf<'step'>): void {
    const { pc } = this;
    const running = this.running.get(pairKey(event.testId, event.target));
    if (running === undefined) return;
    const { progress } = event;
    switch (progress.phase) {
      case 'start': {
        running.step = `${progress.api} ${stepLabel(progress.label)}`;
        running.events = [];
        if (progress.kind === 'agent' && this.running.size === 1 && !running.streaming) {
          running.streaming = true;
          const { group } = running;
          group.streamed = true;
          this.print(
            ` ${pc.yellow(F_POINTER)} ${this.badge(group.target)} ${pc.dim(bounded(group.file))}${this.separator}${running.title}`,
          );
        }
        this.window.redraw();
        break;
      }
      case 'event': {
        const tail = eventTail(progress.event);
        if (running.step === undefined || tail === undefined) break;
        running.events.push(tail);
        this.window.redraw();
        break;
      }
      case 'end': {
        running.step = undefined;
        running.events = [];
        if (progress.kind !== 'agent') {
          this.window.redraw();
          break;
        }
        const glyph = progress.status === 'passed' ? pc.green(F_CHECK) : pc.red(F_CROSS);
        const calls =
          progress.modelCalls > 0
            ? ` · ${progress.modelCalls} model call${progress.modelCalls === 1 ? '' : 's'}`
            : '';
        const outcome = progress.status === 'passed' ? '' : ` ${progress.status}`;
        const context = running.streaming ? '' : `${pc.dim(running.title)}${this.separator}`;
        this.print(
          `   ${glyph} ${context}${pc.dim(progress.api)} ${stepLabel(progress.label)} ` +
            pc.dim(`${formatTime(progress.durationMs)}${calls}${outcome}`),
        );
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
    this.running.delete(pairKey(result.test.id, result.target.name));
    const group = this.group(result.test.file, result.target.name);
    const { durationMs, usage, error } = this.detailsOf(result);
    addUsage(this.runUsage, usage);
    const title = bounded(result.test.titlePath.join(' > '));
    group.lines.push({
      title,
      declarationIndex: result.test.declarationIndex,
      status: result.status,
      durationMs,
      usage,
      firstErrorLine: error === undefined ? undefined : bounded(error.message).split('\n')[0],
      skipReason: result.skip === undefined ? undefined : bounded(result.skip.reason),
    });
    if (statusBucket(result.status) === 'failed') {
      this.failures.push({ group, title, status: result.status, error });
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
   * file failed, had a flaky pass, streamed its steps, or is the run's only
   * file - one line per test, as vitest lists tests for a failed module.
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
      group.streamed ||
      this.groups.size === 1;
    if (!verbose) return;
    const ordered = group.lines.toSorted((a, b) => a.declarationIndex - b.declarationIndex);
    for (const line of ordered) {
      for (const rendered of this.testLine(line)) this.print(rendered);
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
   * files, tests, model usage, run errors, start time, and elapsed time.
   */
  private summaryRows(): string[] {
    const { pc } = this;
    const files = this.fileCounters();
    const tests = this.testCounters();
    const rows = [
      padTitle(pc, 'Test Files') + (files.total === 0 ? pc.dim('no test files') : stateString(pc, files)),
      padTitle(pc, 'Tests') + (tests.total === 0 ? pc.dim('no tests executed') : stateString(pc, tests)),
    ];
    const ai = aiSegment(this.runUsage);
    if (ai !== undefined) rows.push(padTitle(pc, 'AI') + `${ai} · ${this.runUsage.calls} model calls`);
    if (this.errors.length > 0) {
      const count = this.errors.length;
      rows.push(padTitle(pc, 'Errors') + pc.bold(pc.red(`${count} error${count === 1 ? '' : 's'}`)));
    }
    rows.push(padTitle(pc, 'Start at') + formatClock(this.startedAt));
    rows.push(padTitle(pc, 'Duration') + formatTime(Date.now() - this.startedAt.getTime()));
    return rows;
  }

  /**
   * The live window: running files and tests, then the summary. The block
   * must fit the screen, because repainting more rows than the terminal has
   * breaks the cursor-up erase: rows left after the summary go to the running
   * tests, each test's calls share what remains once every test has its own
   * line, and tests that still do not fit fold into one `more running` marker.
   */
  private renderWindow(): string[] {
    const { pc } = this;
    const now = Date.now();
    const active = new Map<FileGroup, RunningTest[]>();
    for (const test of this.running.values()) {
      const tests = active.get(test.group);
      if (tests === undefined) active.set(test.group, [test]);
      else tests.push(test);
    }
    const summary = this.summaryRows();
    let budget = terminalRows() - summary.length - WINDOW_CHROME_ROWS;
    const spare = budget - active.size - this.running.size * WINDOW_ROWS_PER_TEST;
    const maxEvents = Math.max(0, Math.floor(spare / Math.max(1, this.running.size)));
    const lines = [''];
    let hidden = 0;
    for (const [group, tests] of active) {
      if (budget < 2) {
        hidden += tests.length;
        continue;
      }
      const progress = pc.dim(` ${group.lines.length}/${group.planned ?? '?'}`);
      lines.push(
        `${pc.bold(pc.yellow(` ${F_POINTER} `))}${this.badge(group.target)} ${bounded(group.file)}${progress}`,
      );
      budget -= 1;
      tests.forEach((test, index) => {
        if (budget < 1) {
          hidden += 1;
          return;
        }
        const glyph = index === tests.length - 1 ? F_TREE_END : F_TREE_MIDDLE;
        const elapsed = pc.bold(pc.yellow(formatTime(Math.max(0, now - test.startedMs))));
        lines.push(`${pc.bold(pc.yellow(`   ${glyph} `))}${test.title} ${elapsed}`);
        budget -= 1;
        if (test.step === undefined) return;
        const detail = [`       ${pc.dim(`${F_DOWN_RIGHT} ${test.step}`)}`];
        const overflow = test.events.length - maxEvents;
        if (overflow > 0) {
          detail.push(`         ${pc.dim(`… ${overflow} earlier call${overflow === 1 ? '' : 's'}`)}`);
        }
        for (const tail of overflow > 0 ? test.events.slice(overflow) : test.events) {
          detail.push(`         ${pc.dim(tail)}`);
        }
        const shown = detail.slice(0, budget);
        lines.push(...shown);
        budget -= shown.length;
      });
    }
    if (hidden > 0) lines.push(pc.dim(`   … ${hidden} more running`));
    if (active.size > 0) lines.push('');
    lines.push(...summary, '');
    return lines;
  }

  /** vitest's `Failed Tests` section: a banner, then each failure with its code frame. */
  private printFailures(): void {
    const { pc } = this;
    if (this.failures.length === 0) return;
    this.print('');
    this.print(this.errorBanner(`Failed Tests ${this.failures.length}`));
    this.print('');
    this.failures.forEach(({ group, title, status, error }, index) => {
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

  private runFinished(event: RunEventOf<'run-finished'>): void {
    const { pc } = this;
    this.window.stop();
    // An interrupted or crashed run leaves files without their full result
    // set; print what they have so nothing that ran goes unreported.
    for (const group of this.groups.values()) {
      if (!group.printed && group.lines.length > 0) this.printGroup(group);
    }
    this.printFailures();
    this.printErrors();
    this.print('');
    for (const row of this.summaryRows()) this.print(row);
    this.print(
      padTitle(pc, 'Report') +
        (event.reportPath === undefined ? pc.dim('(not written)') : this.displayPath(event.reportPath)),
    );
    if (event.junitPath !== undefined) {
      this.print(padTitle(pc, 'JUnit') + this.displayPath(event.junitPath));
    }
    if (event.aiTracePath !== undefined) {
      const shown = this.displayPath(event.aiTracePath);
      this.print(padTitle(pc, 'AI trace') + `${shown} ${pc.dim(`(open with: npx unbox-ai ${shown})`)}`);
    }
    this.print('');
  }
}
