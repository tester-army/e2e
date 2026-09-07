/**
 * Human-readable list reporter (spec 06-cli.md), styled after vitest's
 * default reporter: one block per test file and target, a `Failed Tests`
 * section with code frames, and a padded summary. On a TTY a live window
 * below the log shows the running files, their tests, and the counters.
 */

import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import picocolors from 'picocolors';
import { sanitizeText, truncateUtf8, type SerializedError } from '../internal/errors.ts';
import { packageVersion } from '../internal/package-version.ts';
import { collapseText } from '../internal/text.ts';
import type { RunEventFact, RunEventOf, RunEventResult } from '../run/events.ts';
import type { ResultStatus, SerialGroupRecord } from '../run/records.ts';
import type { StepEvent, StepRecord } from '../run/steps.ts';
import { codeFrame, userFrame, type Colors } from './code-frame.ts';
import { LiveWindow } from './live-window.ts';

const MAX_FIELD_BYTES = 8192;

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_BYTES = 72;

const F_POINTER = '❯';
const F_CHECK = '✓';
const F_CROSS = '×';
const F_DOWN = '↓';
const F_RIGHT = '→';
const F_DOWN_RIGHT = '↳';
const F_LONG_DASH = '⎯';
const F_TREE_MIDDLE = '├──';
const F_TREE_END = '└──';

/** Indentation under a badge line, matching vitest's banner padding. */
const BADGE_PADDING = '      ';

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

function bounded(text: string): string {
  return truncateUtf8(sanitizeText(text), MAX_FIELD_BYTES);
}

/** One-line, quoted step label bounded for the live view. */
function stepLabel(label: string): string {
  const flat = collapseText(label);
  const shown = truncateUtf8(flat, MAX_STEP_LABEL_BYTES);
  return `"${shown}${shown === flat ? '' : '…'}"`;
}

/** vitest's duration format: whole milliseconds under a second, two decimals above. */
function formatTime(ms: number): string {
  return ms > 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Wall-clock `HH:MM:SS` for the summary's `Start at` row. */
function formatClock(date: Date): string {
  return date.toTimeString().split(' ')[0] ?? '';
}

/** Compact token count: plain under a thousand, `12.4k`, then `4.2M`. */
function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** USD with enough precision for sub-cent model calls. */
function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd < 0.1 ? 4 : 2)}`;
}

function terminalColumns(): number {
  return process.stdout.columns || 80;
}

/** One padded summary title, right-aligned like vitest's `Test Files` column. */
function padTitle(pc: Colors, title: string): string {
  return pc.dim(`${title.padStart(11)}  `);
}

/**
 * A full-width rule with optional centered (or right-anchored) text. `right`
 * fixes the dash count after the text, as vitest does for `[1/3]` markers.
 */
function divider(text: string, color: (text: string) => string, right?: number): string {
  const columns = terminalColumns();
  const width = stripVTControlCharacters(text).length;
  let left: number;
  let after: number;
  if (right === undefined) {
    left = Math.max(0, Math.floor((columns - width) / 2));
    after = Math.max(0, columns - width - left);
  } else {
    after = right;
    left = Math.max(0, columns - width - right);
  }
  return `${color(F_LONG_DASH.repeat(left))}${text}${color(F_LONG_DASH.repeat(after))}`;
}

function errorBanner(pc: Colors, message: string): string {
  return divider(pc.bold(pc.bgRed(` ${message} `)), pc.red);
}

interface Counters {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  total: number;
}

function emptyCounters(): Counters {
  return { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0 };
}

/** `2 failed | 10 passed | 1 flaky (13)` in vitest's colors and order. */
function stateString(pc: Colors, counters: Counters): string {
  const parts = [
    counters.failed > 0 ? pc.bold(pc.red(`${counters.failed} failed`)) : undefined,
    pc.bold(pc.green(`${counters.passed} passed`)),
    counters.flaky > 0 ? pc.yellow(`${counters.flaky} flaky`) : undefined,
    counters.skipped > 0 ? pc.gray(`${counters.skipped} skipped`) : undefined,
  ].filter((part) => part !== undefined);
  return `${parts.join(pc.dim(' | '))}${pc.gray(` (${counters.total})`)}`;
}

interface AiUsage {
  calls: number;
  tokens: number;
  costUsd: number | undefined;
}

function emptyUsage(): AiUsage {
  return { calls: 0, tokens: 0, costUsd: undefined };
}

/** Accumulates the model usage of one step list into a running total. */
function addStepsUsage(usage: AiUsage, steps: readonly StepRecord[]): void {
  for (const step of steps) {
    if (step.model === undefined) continue;
    usage.calls += step.model.calls;
    usage.tokens += step.model.inputTokens + step.model.outputTokens;
    if (step.model.estimatedCostUsd !== undefined) {
      usage.costUsd = (usage.costUsd ?? 0) + step.model.estimatedCostUsd;
    }
  }
}

function addUsage(into: AiUsage, usage: AiUsage): void {
  into.calls += usage.calls;
  into.tokens += usage.tokens;
  if (usage.costUsd !== undefined) into.costUsd = (into.costUsd ?? 0) + usage.costUsd;
}

/**
 * Sums model usage across every step of every attempt of one result. Serial
 * members carry no attempts of their own; their usage arrives once per group
 * through the `serial-group` event.
 */
function resultUsage(result: RunEventResult): AiUsage {
  const usage = emptyUsage();
  for (const attempt of result.attempts) addStepsUsage(usage, attempt.steps);
  return usage;
}

/** One dim `ai …` segment, or undefined when no model was used. */
function aiSegment(usage: AiUsage): string | undefined {
  if (usage.calls === 0) return undefined;
  const cost = usage.costUsd === undefined ? '' : ` · ${formatCost(usage.costUsd)}`;
  return `ai ${formatTokens(usage.tokens)} tokens${cost}`;
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

/** A pair that is executing right now, shown in the live window. */
interface RunningTest {
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
  readonly ai: string | undefined;
  readonly firstErrorLine: string | undefined;
  readonly skipReason: string | undefined;
}

/**
 * Every pair of one test file on one target: vitest's "test module". Its
 * block prints once all planned results are in, so files never interleave.
 */
interface FileGroup {
  readonly file: string;
  readonly target: string;
  /** Reportable pairs the plan announced; undefined until the plan arrives. */
  planned: number | undefined;
  readonly lines: TestLine[];
  readonly running: Map<string, RunningTest>;
  /** A pair of this file streamed its steps permanently, so list every test. */
  streamed: boolean;
  printed: boolean;
  durationMs: number;
  readonly usage: AiUsage;
}

interface Failure {
  readonly group: FileGroup;
  readonly result: RunEventResult;
}

const DEFAULT_OUTPUT: ListReporterOutput = {
  write: (line) => process.stdout.write(`${line}\n`),
  raw: (text) => process.stdout.write(text),
};

/** Badge backgrounds, assigned to targets in declaration order. */
const BADGE_COLORS = ['bgYellow', 'bgCyan', 'bgGreen', 'bgMagenta'] as const;

/**
 * Renders the run's event stream as the CLI's human-readable output. The
 * reporter is one sink on the run's single event spine, beside a host's
 * `onEvent`, so the CLI shows exactly what a host receives.
 */
export class ListReporter {
  private readonly pc: Colors;
  private readonly window: LiveWindow;
  private projectRoot: string | undefined;
  /** Selected targets in declaration order; decides each badge's color. */
  private targets: readonly string[] = [];
  private readonly startedMs = Date.now();
  private startClock = formatClock(new Date());
  /** File groups keyed `${target}\0${file}`, in first-seen order. */
  private readonly groups = new Map<string, FileGroup>();
  private readonly files = emptyCounters();
  private readonly tests = emptyCounters();
  private readonly failures: Failure[] = [];
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
    const index = this.targets.indexOf(target);
    const hash = [...target].reduce((sum, char, i) => sum + char.charCodeAt(0) + i, 0);
    const color = BADGE_COLORS[(index === -1 ? hash : index) % BADGE_COLORS.length]!;
    return this.pc.black(this.pc[color](` ${name} `));
  }

  /** A path relative to the project root when inside it, else as given. */
  private displayPath(target: string): string {
    if (this.projectRoot !== undefined && target.startsWith(`${this.projectRoot}${path.sep}`)) {
      return path.relative(this.projectRoot, target);
    }
    return target;
  }

  private separator(): string {
    return this.pc.dim(' > ');
  }

  private group(file: string, target: string): FileGroup {
    const key = `${target} ${file}`;
    let group = this.groups.get(key);
    if (group === undefined) {
      group = {
        file,
        target,
        planned: undefined,
        lines: [],
        running: new Map(),
        streamed: false,
        printed: false,
        durationMs: 0,
        usage: emptyUsage(),
      };
      this.groups.set(key, group);
    }
    return group;
  }

  private runStarted(event: RunEventOf<'run-started'>): void {
    const { pc } = this;
    this.projectRoot = event.projectRoot;
    this.targets = event.targets;
    this.startClock = formatClock(new Date());
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
      const group = this.group(planned.file, planned.target);
      group.planned = planned.tests;
      this.tests.total += planned.tests;
    }
    this.files.total = event.files.length;
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

  /** A worker began one test-target pair: show it in the live window. */
  private testStarted(event: RunEventOf<'test-started'>): void {
    const group = this.group(event.file, event.target);
    group.running.set(event.testId, {
      title: bounded(event.title),
      startedMs: Date.now(),
      step: undefined,
      events: [],
      streaming: false,
    });
    this.window.redraw();
  }

  private runningCount(): number {
    let count = 0;
    for (const group of this.groups.values()) count += group.running.size;
    return count;
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
    const group = this.groups.get(`${event.target} ${this.fileOf(event.testId, event.target)}`);
    const running = group?.running.get(event.testId);
    if (group === undefined || running === undefined) return;
    const { progress } = event;
    switch (progress.phase) {
      case 'start': {
        running.step = `${progress.api} ${stepLabel(progress.label)}`;
        running.events = [];
        if (progress.kind === 'agent' && this.runningCount() === 1 && !running.streaming) {
          running.streaming = true;
          group.streamed = true;
          this.print(
            ` ${pc.yellow(F_POINTER)} ${this.badge(group.target)} ${pc.dim(bounded(group.file))}${this.separator()}${running.title}`,
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
        const context = running.streaming ? '' : `${pc.dim(running.title)}${this.separator()}`;
        this.print(
          `   ${glyph} ${context}${pc.dim(progress.api)} ${stepLabel(progress.label)} ` +
            pc.dim(`${formatTime(progress.durationMs)}${calls}${outcome}`),
        );
        break;
      }
    }
  }

  /** The file of a running pair; step events carry the test id and target only. */
  private fileOf(testId: string, target: string): string | undefined {
    for (const group of this.groups.values()) {
      if (group.target === target && group.running.has(testId)) return group.file;
    }
    return undefined;
  }

  /**
   * Adds one serial group's model usage to the run totals. Member result
   * records intentionally carry no attempts, so the group record is the one
   * place their steps exist; summing here counts each member exactly once.
   */
  private serialGroup(group: SerialGroupRecord): void {
    for (const attempt of group.attempts) {
      for (const member of attempt.members) addStepsUsage(this.runUsage, member.steps);
    }
  }

  private testFinished(result: RunEventResult): void {
    // Unselected pairs are report-only: they never print and the plan never
    // counted them.
    if (!result.selected) return;
    const group = this.group(result.test.file, result.target.name);
    group.running.delete(result.test.id);
    const usage = resultUsage(result);
    addUsage(this.runUsage, usage);
    addUsage(group.usage, usage);
    const durationMs = result.attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
    group.durationMs += durationMs;
    const error = result.attempts[result.attempts.length - 1]?.error;
    group.lines.push({
      title: bounded(result.test.titlePath.join(' > ')),
      declarationIndex: result.test.declarationIndex ?? 0,
      status: result.status,
      durationMs,
      ai: aiSegment(usage),
      firstErrorLine: error === undefined ? undefined : bounded(error.message).split('\n')[0],
      skipReason: result.skip === undefined ? undefined : bounded(result.skip.reason),
    });
    switch (result.status) {
      case 'passed':
        this.tests.passed += 1;
        break;
      case 'flaky':
        this.tests.flaky += 1;
        break;
      case 'skipped':
        this.tests.skipped += 1;
        break;
      default:
        this.tests.failed += 1;
        this.failures.push({ group, result });
    }
    if (group.planned === undefined) this.tests.total += 1;
    if (group.planned !== undefined && group.lines.length >= group.planned) this.printGroup(group);
    this.window.redraw();
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
    const counts = emptyCounters();
    for (const line of group.lines) {
      counts.total += 1;
      if (line.status === 'passed') counts.passed += 1;
      else if (line.status === 'flaky') counts.flaky += 1;
      else if (line.status === 'skipped') counts.skipped += 1;
      else counts.failed += 1;
    }
    if (group.planned === undefined) this.files.total += 1;
    const allSkipped = counts.skipped === counts.total && counts.total > 0;
    let symbol: string;
    if (counts.failed > 0) {
      this.files.failed += 1;
      symbol = pc.red(F_POINTER);
    } else if (allSkipped) {
      this.files.skipped += 1;
      symbol = pc.dim(pc.gray(F_DOWN));
    } else {
      this.files.passed += 1;
      symbol = pc.green(F_CHECK);
    }
    const state = [
      pc.dim(`${counts.total} test${counts.total === 1 ? '' : 's'}`),
      counts.failed > 0 ? pc.red(`${counts.failed} failed`) : undefined,
      counts.flaky > 0 ? pc.yellow(`${counts.flaky} flaky`) : undefined,
      counts.skipped > 0 ? pc.yellow(`${counts.skipped} skipped`) : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(pc.dim(' | '));
    const ai = aiSegment(group.usage);
    const parts = [
      ` ${symbol} ${this.badge(group.target)} ${bounded(group.file)}`,
      `${pc.dim('(')}${state}${pc.dim(')')}`,
      pc.dim(formatTime(group.durationMs)),
    ];
    if (ai !== undefined) parts.push(pc.dim(ai));
    this.print(parts.join(' '));
    const verbose =
      counts.failed > 0 || counts.flaky > 0 || group.streamed || this.groups.size === 1;
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
    const ai = line.ai === undefined ? '' : ` ${pc.dim(line.ai)}`;
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
          rows.push(`     ${pc.red(`${F_RIGHT} ${line.firstErrorLine}`)}`);
        }
        return rows;
      }
    }
  }

  /** The live window: running files and tests, then the counters. */
  private renderWindow(): string[] {
    const { pc } = this;
    const now = Date.now();
    const lines = [''];
    const active = [...this.groups.values()].filter((group) => group.running.size > 0);
    const runningTotal = active.reduce((sum, group) => sum + group.running.size, 0);
    // The block must fit the screen: repainting more rows than the terminal
    // has breaks the cursor-up erase, so each test gets a share of the rows
    // left after the fixed lines and the oldest calls fold into a counter.
    const spare = (process.stdout.rows ?? 40) - 12 - active.length - runningTotal * 2;
    const maxEvents = Math.max(1, Math.floor(spare / Math.max(1, runningTotal)));
    for (const group of active) {
      const progress = pc.dim(` ${group.lines.length}/${group.planned ?? '?'}`);
      lines.push(
        `${pc.bold(pc.yellow(` ${F_POINTER} `))}${this.badge(group.target)} ${bounded(group.file)}${progress}`,
      );
      const running = [...group.running.values()];
      running.forEach((test, index) => {
        const glyph = index === running.length - 1 ? F_TREE_END : F_TREE_MIDDLE;
        const elapsed = pc.bold(pc.yellow(formatTime(Math.max(0, now - test.startedMs))));
        lines.push(`${pc.bold(pc.yellow(`   ${glyph} `))}${test.title} ${elapsed}`);
        if (test.step === undefined) return;
        lines.push(`       ${pc.dim(`${F_DOWN_RIGHT} ${test.step}`)}`);
        const overflow = test.events.length - maxEvents;
        if (overflow > 0) {
          lines.push(`         ${pc.dim(`… ${overflow} earlier call${overflow === 1 ? '' : 's'}`)}`);
        }
        for (const tail of overflow > 0 ? test.events.slice(overflow) : test.events) {
          lines.push(`         ${pc.dim(tail)}`);
        }
      });
    }
    if (active.length > 0) lines.push('');
    lines.push(padTitle(pc, 'Test Files') + stateString(pc, this.files));
    lines.push(padTitle(pc, 'Tests') + stateString(pc, this.tests));
    lines.push(padTitle(pc, 'Start at') + this.startClock);
    lines.push(padTitle(pc, 'Duration') + formatTime(now - this.startedMs));
    lines.push('');
    return lines;
  }

  /** vitest's `Failed Tests` section: a banner, then each failure with its code frame. */
  private printFailures(): void {
    const { pc } = this;
    if (this.failures.length === 0) return;
    this.print('');
    this.print(errorBanner(pc, `Failed Tests ${this.failures.length}`));
    this.print('');
    this.failures.forEach(({ group, result }, index) => {
      const title = bounded(result.test.titlePath.join(' > '));
      this.print(
        `${pc.bold(pc.bgRed(' FAIL '))} ${this.badge(group.target)} ${bounded(group.file)}${this.separator()}${title}`,
      );
      const error = result.attempts[result.attempts.length - 1]?.error;
      if (error === undefined) {
        this.print(pc.red(`${pc.bold(result.status)}: no error was recorded`));
      } else {
        const [first = '', ...rest] = bounded(error.message).split('\n');
        this.print(pc.red(`${pc.bold(error.code)}: ${first}`));
        for (const line of rest) this.print(pc.red(line));
        this.printFailureLocation(error.stack);
      }
      this.print('');
      this.print(pc.red(pc.dim(divider(`[${index + 1}/${this.failures.length}]`, (t) => t, 1))));
      this.print('');
    });
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
    this.print(errorBanner(pc, `Run Errors ${this.errors.length}`));
    this.print('');
    for (const error of this.errors) {
      const phase = error.phase === undefined ? '' : pc.dim(` (${error.phase})`);
      this.print(
        `${pc.bold(pc.bgRed(' ERROR '))} ${error.category} error ${pc.dim(error.code)}${phase}`,
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
    const ai = aiSegment(this.runUsage);
    this.output.write('');
    this.output.write(
      padTitle(pc, 'Test Files') +
        (this.files.total === 0 ? pc.dim('no test files') : stateString(pc, this.files)),
    );
    this.output.write(
      padTitle(pc, 'Tests') +
        (this.tests.total === 0 ? pc.dim('no tests executed') : stateString(pc, this.tests)),
    );
    if (ai !== undefined) {
      this.output.write(padTitle(pc, 'AI') + `${ai} · ${this.runUsage.calls} model calls`);
    }
    if (this.errors.length > 0) {
      const count = this.errors.length;
      this.output.write(
        padTitle(pc, 'Errors') + pc.bold(pc.red(`${count} error${count === 1 ? '' : 's'}`)),
      );
    }
    this.output.write(padTitle(pc, 'Start at') + this.startClock);
    this.output.write(padTitle(pc, 'Duration') + formatTime(Date.now() - this.startedMs));
    this.output.write(
      padTitle(pc, 'Report') +
        (event.reportPath === undefined ? pc.dim('(not written)') : this.displayPath(event.reportPath)),
    );
    if (event.junitPath !== undefined) {
      this.output.write(padTitle(pc, 'JUnit') + this.displayPath(event.junitPath));
    }
    if (event.aiTracePath !== undefined) {
      const shown = this.displayPath(event.aiTracePath);
      this.output.write(
        padTitle(pc, 'AI trace') + `${shown} ${pc.dim(`(open with: npx unbox-ai ${shown})`)}`,
      );
    }
    this.output.write('');
  }
}
