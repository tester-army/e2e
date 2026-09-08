/**
 * Human-readable list reporter, styled after vitest's
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
import type { StepEvent, StepKind } from '../run/steps.ts';
import { codeFrame, userFrame } from './code-frame.ts';
import {
  addUsage,
  aiSegment,
  bounded,
  detectNerdFont,
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
  usageText,
  visibleWidth,
  type AiUsage,
  type Colors,
  type Counters,
} from './format.ts';
import { LiveWindow } from './live-window.ts';

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_BYTES = 72;
/** A finished step line keeps at least this much of its label when the terminal is narrow. */
const MIN_STEP_LABEL_CHARS = 24;

const F_POINTER = '❯';
const F_CHECK = '✓';
const F_CROSS = '×';
const F_DOWN = '↓';
const F_RIGHT = '→';
const F_DOWN_RIGHT = '↳';
const F_TREE_MIDDLE = '├──';
const F_TREE_END = '└──';
/** A finished model turn in the live window. */
const F_MODEL = '•';
/**
 * A tool call the model made, in the live window: the Nerd Font wrench
 * (private use U+F0AD). Unicode has no text-presentation wrench, and the emoji
 * one renders in color everywhere, so terminals without a Nerd Font get a
 * blank marker and the row stands apart by indentation alone.
 */
const F_TOOL_NERD = '\uf0ad';
const F_TOOL_PLAIN = ' ';
const F_INPUT = '↑';
const F_OUTPUT = '↓';
/**
 * Spinner for the live row: an asterisk blooming and folding back. Centered
 * dingbats, unlike six-dot braille, which sits in the top-left of its cell.
 */
const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
/** One animation frame; the live window repaints at this cadence. */
const FRAME_MS = 80;
/** Frames each spinner glyph holds; the bloom reads better slower than the shimmer. */
const SPINNER_HOLD_FRAMES = 2;
/** Frames the shimmer rests after each sweep across the status word. */
const SHIMMER_REST_FRAMES = 6;

/**
 * A bright highlight sweeping over `word` one character per frame, resting a
 * few frames between sweeps: the status word reads as alive without moving.
 */
function shimmer(pc: Colors, word: string, frame: number): string {
  const chars = [...word];
  const head = frame % (chars.length + SHIMMER_REST_FRAMES);
  return chars
    .map((char, index) => {
      const distance = Math.abs(index - head);
      if (distance === 0) return pc.bold(pc.white(char));
      if (distance === 1) return pc.white(char);
      return pc.dim(char);
    })
    .join('');
}

/** Indentation under a badge line, matching vitest's banner padding. */
const BADGE_PADDING = '      ';
/** Indentation of a test line under its file line. */
const TEST_INDENT = '   ';
/** Indentation of a finished agent step under its test line in a file block. */
const STEP_INDENT = '     ';
/** Indentation of a running test's detail (steps, calls) under its row in the live window. */
const WINDOW_DETAIL_INDENT = '       ';

/**
 * Badge backgrounds, assigned to targets in declaration order. Bright variants
 * because GitHub Actions renders plain yellow as dark brown, which swallows the
 * black label.
 */
const BADGE_COLORS = ['bgYellowBright', 'bgCyanBright', 'bgGreenBright', 'bgMagentaBright'] as const;

/**
 * Rows the live window spends outside the running tests and the summary: its
 * blank lines, the `… more running` marker, and a margin above the prompt.
 */
const WINDOW_CHROME_ROWS = 6;
/**
 * Rows reserved for the running area from the first paint: one file row, one
 * test row, its current step, the calls the window shows, the turn in flight,
 * and a few finished steps. The area never shrinks during the run, so the
 * summary below it stays put instead of jumping as calls come and go.
 */
const WINDOW_RESERVED_ROWS = 14;
/**
 * Most recent calls of a step the live window shows; older ones fold into the
 * `… earlier calls` marker so a tall terminal does not fill with model turns.
 */
const MAX_WINDOW_EVENTS = 6;
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
  /** Use Nerd Font glyphs; defaults to `detectNerdFont` (terminals known to bundle them). */
  nerdFont?: boolean;
}

/**
 * One-line, quoted step label bounded for the live view; `maxChars` clips it
 * further so a finished step line fits the terminal instead of wrapping.
 */
function stepLabel(label: string, maxChars = Number.POSITIVE_INFINITY): string {
  const flat = collapseText(label);
  const bytesBounded = truncateUtf8(flat, MAX_STEP_LABEL_BYTES);
  const shown = ellipsize(bytesBounded, Math.max(MIN_STEP_LABEL_CHARS, maxChars));
  const clipped = shown !== bytesBounded || bytesBounded !== flat;
  return `"${shown}${clipped && !shown.endsWith('…') ? '…' : ''}"`;
}

/** Kinds of step events the live window shows; the rest stay quiet. */
type ShownEventKind = 'model' | 'engine';

/**
 * `(↑in ↓out)` for one model call, the total when only that is known, or
 * nothing when the provider reported no usage.
 */
function tokenSplit(event: StepEvent): string {
  if (event.inputTokens !== undefined && event.outputTokens !== undefined) {
    return ` (${F_INPUT}${formatTokens(event.inputTokens)} ${F_OUTPUT}${formatTokens(event.outputTokens)})`;
  }
  return event.count !== undefined && event.count > 0 ? ` (${formatTokens(event.count)} tokens)` : '';
}

/**
 * Live tail for one step event. Model turns and tool calls are the ones worth
 * a glance (`tool:` prefixes come from executor tool accounting); polls and
 * policy decisions stay quiet. A tool call reads as the act it performed when
 * the engine described it, else as the tool name.
 */
function eventTail(
  pc: Colors,
  toolGlyph: string,
  event: StepEvent,
): { kind: ShownEventKind; text: string } | undefined {
  if (event.kind === 'model') {
    return {
      kind: 'model',
      text: pc.dim(`${F_MODEL} Thinking (${formatTime(event.durationMs)})${tokenSplit(event)}`),
    };
  }
  if (event.kind === 'engine') {
    const name = sanitizeText(event.name ?? 'engine').replace(/^tool:/, '');
    const act = event.detail === undefined ? name : sanitizeText(collapseText(event.detail));
    const failed = event.status === 'passed' ? '' : ` ${pc.red(F_CROSS)}`;
    return {
      kind: 'engine',
      text: `${pc.dim(`${toolGlyph} ${truncateUtf8(act, 60)} (${formatTime(event.durationMs)})`)}${failed}`,
    };
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
  /** Kind of the current step; only an agent step has model turns to wait on. */
  stepKind: StepKind | undefined;
  /**
   * Rendered model turns and tool calls of the current step in causal order:
   * each turn before the tool calls it made. The executor reports a turn only
   * after its tools ran, so the turn's row is inserted ahead of them.
   */
  events: string[];
  /** Index in `events` where the tool calls of the turn still in flight begin. */
  turnStart: number;
  /**
   * Finished agent steps, rendered without indentation, oldest first. Shown
   * under the test in the live window while it runs and nested under its line
   * in the file block once it is done; the same array travels into `TestLine`.
   */
  readonly steps: string[];
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
  /** Finished agent steps to nest under the line, rendered without indentation. */
  readonly steps: readonly string[];
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
  /** Marker before a tool call in the live window: the wrench, or blank without a Nerd Font. */
  private readonly toolGlyph: string;
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
  /**
   * Finished agent steps of pairs whose result is still to come, keyed by
   * `pairKey`. Outlives `running` because a serial member leaves it before
   * its result arrives.
   */
  private readonly stepsOf = new Map<string, string[]>();
  /** Whether a live window paints; without one, finished steps stream permanently. */
  private readonly live: boolean;
  /** High-water mark of the running area's rows; the window pads up to it. */
  private reservedRows = WINDOW_RESERVED_ROWS;
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
    this.live = live;
    this.pc = picocolors.createColors(options.colors ?? (live || picocolors.isColorSupported));
    this.toolGlyph = (options.nerdFont ?? detectNerdFont()) ? F_TOOL_NERD : F_TOOL_PLAIN;
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
      group = { file, target, planned: undefined, lines: [], printed: false };
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
    if (event.model !== undefined) {
      this.output.write(BADGE_PADDING + pc.dim(`model ${bounded(event.model)}`));
    }
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
    const key = pairKey(event.testId, event.target);
    const steps: string[] = [];
    this.stepsOf.set(key, steps);
    this.running.set(key, {
      group: this.group(event.file, event.target),
      serialId: event.serialId,
      title: bounded(event.title),
      startedMs: Date.now(),
      step: undefined,
      stepKind: undefined,
      events: [],
      turnStart: 0,
      steps,
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
    const { pc } = this;
    const running = this.running.get(pairKey(event.testId, event.target));
    if (running === undefined) return;
    const { progress } = event;
    switch (progress.phase) {
      case 'start': {
        running.step = `${progress.api} ${stepLabel(progress.label)}`;
        running.stepKind = progress.kind;
        running.events = [];
        running.turnStart = 0;
        this.window.redraw();
        break;
      }
      case 'event': {
        const tail = eventTail(pc, this.toolGlyph, progress.event);
        if (running.step === undefined || tail === undefined) break;
        if (tail.kind === 'model') {
          running.events.splice(running.turnStart, 0, tail.text);
          running.turnStart = running.events.length;
        } else {
          running.events.push(tail.text);
        }
        this.window.redraw();
        break;
      }
      case 'end': {
        running.step = undefined;
        running.stepKind = undefined;
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
        const context = this.live ? '' : `${pc.dim(running.title)}${this.separator}`;
        const head = `${glyph} ${context}${pc.dim(progress.api)} `;
        const tail = pc.dim(`${formatTime(progress.durationMs)}${calls}${outcome}`);
        // Clip the label so the line stays one row at its deepest indent, the
        // live window's; wrapping breaks the tree.
        const room =
          terminalColumns() - WINDOW_DETAIL_INDENT.length - visibleWidth(head) - visibleWidth(tail) - 4;
        const line = `${head}${stepLabel(progress.label, room)} ${tail}`;
        if (this.live) {
          running.steps.push(line);
          this.window.redraw();
        } else {
          this.print(`${TEST_INDENT}${line}`);
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
    const key = pairKey(result.test.id, result.target.name);
    this.running.delete(key);
    const steps = this.stepsOf.get(key) ?? [];
    this.stepsOf.delete(key);
    const group = this.group(result.test.file, result.target.name);
    const { durationMs, usage, error } = this.detailsOf(result);
    addUsage(this.runUsage, usage);
    const title = bounded(result.test.titlePath.join(' > '));
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
   * file failed, had a flaky pass, or is the run's only file - one line per
   * test with its finished agent steps nested, as vitest lists tests for a
   * failed module.
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
    const verbose = counts.failed > 0 || counts.flaky > 0 || this.groups.size === 1;
    if (!verbose) return;
    const ordered = group.lines.toSorted((a, b) => a.declarationIndex - b.declarationIndex);
    for (const line of ordered) {
      for (const rendered of this.testLine(line)) this.print(rendered);
      for (const step of line.steps) this.print(`${STEP_INDENT}${step}`);
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
    const ai = usageText(this.runUsage);
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
   * The current step of a running pair and, for an agent step, its calls and
   * the turn in flight, at most `budget` rows. Older calls fold into one
   * marker. No clock here: the test row above carries the one clock, so the
   * eye has a single moving number per running test.
   */
  private stepRows(test: RunningTest, maxEvents: number, budget: number, now: number): string[] {
    const { pc } = this;
    if (test.step === undefined) return [];
    const rows = [pc.dim(`${F_DOWN_RIGHT} ${test.step}`)];
    if (test.stepKind !== 'agent') return rows.slice(0, budget);
    const overflow = test.events.length - maxEvents;
    if (overflow > 0) {
      rows.push(`  ${pc.dim(`… ${overflow} earlier call${overflow === 1 ? '' : 's'}`)}`);
    }
    for (const tail of overflow > 0 ? test.events.slice(overflow) : test.events) {
      rows.push(`  ${tail}`);
    }
    rows.push(`  ${this.waitingRow(now)}`);
    return rows.slice(0, budget);
  }

  /** The one ticking clock of a running test, on its row. */
  private clock(elapsedMs: number): string {
    return this.pc.bold(this.pc.yellow(formatTime(Math.max(0, elapsedMs))));
  }

  /**
   * Everything under a running test's row: its finished steps, then the
   * current step. The current step has priority; finished steps take the rows
   * left and the oldest fold into one marker.
   */
  private detailRows(test: RunningTest, maxEvents: number, budget: number, now: number): string[] {
    const { pc } = this;
    const current = this.stepRows(test, maxEvents, budget, now);
    const room = budget - current.length;
    let finished: string[] = [];
    if (room > 0) {
      const overflow = test.steps.length - room;
      finished =
        overflow > 0
          ? [pc.dim(`… ${overflow + 1} earlier step${overflow + 1 === 1 ? '' : 's'}`), ...test.steps.slice(overflow + 1)]
          : [...test.steps];
    }
    return [...finished, ...current].map((row) => `${WINDOW_DETAIL_INDENT}${row}`);
  }

  /**
   * The model turn in flight: a spinner and a shimmering `Thinking`. Tool
   * calls take milliseconds and are reported before their turn, so between
   * events the model is always the one working.
   */
  private waitingRow(now: number): string {
    const { pc } = this;
    const frame = Math.floor(now / FRAME_MS);
    const spinner = pc.cyan(SPINNER_FRAMES[Math.floor(frame / SPINNER_HOLD_FRAMES) % SPINNER_FRAMES.length]!);
    return `${spinner} ${shimmer(pc, 'Thinking', frame)}`;
  }

  /**
   * The live window: running files and tests with their steps, then the
   * summary. The block must fit the screen, because repainting more rows than
   * the terminal has breaks the cursor-up erase: rows left after the summary
   * go to the running tests, each test's detail shares what remains once every
   * test has its own row, and tests that still do not fit fold into one
   * `more running` marker.
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
    const perTest = Math.max(
      0,
      Math.floor((budget - active.size - this.running.size) / Math.max(1, this.running.size)),
    );
    const maxEvents = Math.min(MAX_WINDOW_EVENTS, perTest);
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
        lines.push(`${pc.bold(pc.yellow(`   ${glyph} `))}${test.title} ${this.clock(now - test.startedMs)}`);
        budget -= 1;
        const detail = this.detailRows(test, maxEvents, Math.min(perTest, budget), now);
        lines.push(...detail);
        budget -= detail.length;
      });
    }
    if (hidden > 0) lines.push(pc.dim(`   … ${hidden} more running`));
    // Pad the running area to its reserved height so the summary does not move.
    const available = terminalRows() - summary.length - WINDOW_CHROME_ROWS + 1;
    this.reservedRows = Math.min(available, Math.max(this.reservedRows, lines.length));
    while (lines.length < this.reservedRows) lines.push('');
    lines.push('', ...summary, '');
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
