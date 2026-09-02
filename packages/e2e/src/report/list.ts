/** Human-readable list reporter (spec 06-cli.md). */

import path from 'node:path';
import picocolors from 'picocolors';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import type { RunEventResult, RunEventSink } from '../run/events.ts';
import type { RunError, SerialGroupRecord } from '../run/records.ts';
import type { StepEvent, StepProgress, StepRecord } from '../run/steps.ts';
import { codeFrame, userFrame } from './code-frame.ts';
import { LiveStatus } from './live-status.ts';

const MAX_FIELD_BYTES = 8192;

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_CHARS = 72;

export interface ListReporterOutput {
  write(line: string): void;
  /** Raw control write for live status rendering; omit to disable it. */
  raw?(text: string): void;
}

function bounded(text: string): string {
  return truncateUtf8(sanitizeText(text), MAX_FIELD_BYTES);
}

/** One-line, quoted step label bounded for the live view. */
function stepLabel(label: string): string {
  const flat = sanitizeText(label).replace(/\s+/g, ' ').trim();
  return `"${truncateUtf8(flat, MAX_STEP_LABEL_CHARS)}${flat.length > MAX_STEP_LABEL_CHARS ? '…' : ''}"`;
}

/** Human duration: milliseconds under a second, one decimal above. */
function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
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

interface AiUsage {
  calls: number;
  tokens: number;
  costUsd: number | undefined;
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

/**
 * Sums model usage across every step of every attempt of one result. Serial
 * members carry no attempts of their own; their usage arrives once per group
 * through `onSerialGroup`.
 */
function aiUsage(result: RunEventResult): AiUsage {
  const usage: AiUsage = { calls: 0, tokens: 0, costUsd: undefined };
  for (const attempt of result.attempts) addStepsUsage(usage, attempt.steps);
  return usage;
}

/** One dim `ai …` segment, or undefined when the test used no model. */
function aiSegment(usage: AiUsage): string | undefined {
  if (usage.calls === 0) return undefined;
  const cost = usage.costUsd === undefined ? '' : ` · ${formatCost(usage.costUsd)}`;
  return `ai ${formatTokens(usage.tokens)} tokens${cost}`;
}

/**
 * Live tail for one step event. Model and driver calls are the ones worth a
 * glance (`tool:` prefixes come from executor tool accounting); polls and
 * policy decisions stay quiet.
 */
function eventTail(event: StepEvent): string | undefined {
  if (event.kind === 'model') {
    const tokens =
      event.count !== undefined && event.count > 0 ? ` · ${formatTokens(event.count)} tokens` : '';
    return `model turn ${formatDuration(event.durationMs)}${tokens}`;
  }
  if (event.kind === 'driver') {
    const name = sanitizeText(event.name ?? 'driver').replace(/^tool:/, '');
    const failed = event.status === 'passed' ? '' : ' ✗';
    return `${truncateUtf8(name, 40)} ${formatDuration(event.durationMs)}${failed}`;
  }
  return undefined;
}

const DEFAULT_OUTPUT: ListReporterOutput = {
  write: (line) => process.stdout.write(`${line}\n`),
  raw: (text) => process.stdout.write(text),
};

export class ListReporter {
  private passed = 0;
  private failed = 0;
  private flaky = 0;
  private skipped = 0;
  private projectRoot: string | undefined;
  private readonly status: LiveStatus;
  /** Base live-status text of each running pair, keyed `${testId}@${target}`. */
  private readonly liveBase = new Map<string, string>();
  /** Current step line of each running pair, rendered under its header. */
  private readonly liveStep = new Map<string, string>();
  /** Rolling window of the running step's latest model and driver calls. */
  private readonly liveEvents = new Map<string, string[]>();
  /** Pairs whose permanent header line has been written. */
  private readonly headerPrinted = new Set<string>();
  /** Run-wide model usage, summed from every reported result. */
  private readonly runAi: AiUsage = { calls: 0, tokens: 0, costUsd: undefined };
  /** Colors follow live rendering: non-interactive sinks get plain text. */
  private readonly pc: ReturnType<typeof picocolors.createColors>;

  constructor(
    private readonly output: ListReporterOutput = DEFAULT_OUTPUT,
    options: { live?: boolean } = {},
  ) {
    const live = (options.live ?? process.stdout.isTTY === true) && output.raw !== undefined;
    this.status = new LiveStatus(live ? output.raw?.bind(output) : undefined);
    this.pc = picocolors.createColors(live);
  }

  onRunStart(info: {
    runId: string;
    targets: readonly string[];
    ci: boolean;
    projectRoot?: string;
  }): void {
    this.projectRoot = info.projectRoot;
    this.output.write(
      this.pc.dim(
        `e2e run ${info.runId} (targets: ${info.targets.join(', ')})${info.ci ? ' [CI]' : ''}`,
      ),
    );
  }

  /** Announces how many test-target pairs the run will execute. */
  onPlan(info: { total: number }): void {
    this.status.plan(info.total);
  }

  /** A worker began one test-target pair: show it in the live status block. */
  onTestStart(info: { id: string; title: string; target: string }): void {
    const key = `${info.id}@${info.target}`;
    const base = `${bounded(info.title)} ${this.pc.dim(`[${info.target}]`)}`;
    this.liveBase.set(key, base);
    this.status.start(key, base);
    // A second concurrent pair ends permanent streaming: entries the stream
    // had hidden come back as block rows.
    if (this.liveBase.size > 1) {
      for (const [other, otherBase] of this.liveBase) this.redrawLive(other, otherBase);
    }
  }

  /**
   * Streams step progress of a running pair. With a single test running, the
   * whole story prints permanently and chronologically: a test header, one
   * line per step, one line per model or driver call, and a step summary -
   * the scrollback of a run reads without `--debug`. With parallel tests the
   * stream would interleave, so each pair instead shows its current step and
   * latest calls transiently in the live block.
   */
  onProgress(info: { testId: string; target: string; progress: StepProgress }): void {
    const key = `${info.testId}@${info.target}`;
    const base = this.liveBase.get(key);
    if (base === undefined) return;
    const { progress } = info;
    switch (progress.phase) {
      case 'start': {
        this.liveStep.set(key, `${progress.api} ${stepLabel(progress.label)}`);
        this.liveEvents.delete(key);
        if (this.liveBase.size === 1) this.ensureHeader(key, base);
        this.redrawLive(key, base);
        break;
      }
      case 'event': {
        const tail = eventTail(progress.event);
        if (!this.liveStep.has(key) || tail === undefined) break;
        const recent = this.liveEvents.get(key) ?? [];
        recent.push(tail);
        this.liveEvents.set(key, recent);
        this.redrawLive(key, base);
        break;
      }
      case 'end': {
        this.liveStep.delete(key);
        this.liveEvents.delete(key);
        this.redrawLive(key, base);
        if (progress.kind !== 'agent') break;
        const glyph = progress.status === 'passed' ? this.pc.green('✓') : this.pc.red('✗');
        const calls =
          progress.modelCalls > 0
            ? ` · ${progress.modelCalls} model call${progress.modelCalls === 1 ? '' : 's'}`
            : '';
        const outcome = progress.status === 'passed' ? '' : ` ${progress.status}`;
        this.writeAboveStatus(
          `  ${glyph} ${this.pc.dim(progress.api)} ${stepLabel(progress.label)} ` +
            this.pc.dim(`${formatDuration(progress.durationMs)}${calls}${outcome}`),
        );
        break;
      }
    }
  }

  /**
   * Adds one serial group's model usage to the run totals. Member result
   * records intentionally carry no attempts, so the group record is the one
   * place their steps exist; summing here counts each member exactly once.
   */
  onSerialGroup(group: SerialGroupRecord): void {
    for (const attempt of group.attempts) {
      for (const member of attempt.members) {
        addStepsUsage(this.runAi, member.steps);
      }
    }
  }

  /** Writes one permanent line without disturbing the live block. */
  private writeAboveStatus(line: string): void {
    this.status.erase();
    this.output.write(line);
    this.status.redraw();
  }

  /**
   * Prints the permanent test header once, before its first step line, so
   * collapsed step summaries read under the test they belong to.
   */
  private ensureHeader(key: string, base: string): void {
    if (this.headerPrinted.has(key)) return;
    this.headerPrinted.add(key);
    this.writeAboveStatus(`${this.pc.dim('▸')} ${base}`);
  }

  /**
   * Repaints one live entry: only the active step expands, showing its latest
   * calls under the spinner line; between steps the entry collapses to the
   * counter (its header is already permanent) or, before any step ran, the
   * test title. With parallel pairs the title stays as block context.
   */
  private redrawLive(key: string, base: string): void {
    const solo = this.liveBase.size === 1 && this.headerPrinted.has(key);
    const step = this.liveStep.get(key);
    if (step === undefined) {
      this.status.start(key, solo ? undefined : base);
      return;
    }
    const head = solo ? this.pc.dim(step) : `${base}\n    ${this.pc.dim(`▸ ${step}`)}`;
    const indent = solo ? '      ' : '        ';
    const lines = [head];
    // Every call of the active step stays visible until the step collapses.
    // The block must still fit the screen: repainting more rows than the
    // terminal has breaks the cursor-up erase, so the oldest calls fold into
    // one counter line when height runs out.
    const events = this.liveEvents.get(key) ?? [];
    const maxEvents = Math.max(4, (process.stdout.rows ?? 40) - 8);
    const overflow = events.length - maxEvents;
    const shown = overflow > 0 ? events.slice(overflow) : events;
    if (overflow > 0) {
      lines.push(`${indent}${this.pc.dim(`… ${overflow} earlier call${overflow === 1 ? '' : 's'}`)}`);
    }
    for (const tail of shown) {
      lines.push(`${indent}${this.pc.dim(tail)}`);
    }
    this.status.start(key, lines.join('\n'));
  }

  onResult(result: RunEventResult): void {
    if (!result.selected && result.status === 'skipped') {
      this.status.skip();
      return;
    }
    this.status.erase();
    const key = `${result.test.id}@${result.target.name}`;
    this.status.finish(key);
    this.liveBase.delete(key);
    this.liveStep.delete(key);
    this.liveEvents.delete(key);
    this.headerPrinted.delete(key);
    const title = bounded(result.test.titlePath.join(' \u203a '));
    const target = result.target.name;
    const duration = result.attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
    const usage = aiUsage(result);
    this.runAi.calls += usage.calls;
    this.runAi.tokens += usage.tokens;
    if (usage.costUsd !== undefined) this.runAi.costUsd = (this.runAi.costUsd ?? 0) + usage.costUsd;
    const ai = aiSegment(usage);
    const aiSuffix = ai === undefined ? '' : ` \u00b7 ${ai}`;
    switch (result.status) {
      case 'passed':
        this.passed += 1;
        this.output.write(
          `${this.pc.green('\u2713')} ${title} ${this.pc.dim(`[${target}] ${formatDuration(duration)}${aiSuffix}`)}`,
        );
        break;
      case 'flaky':
        this.flaky += 1;
        this.output.write(
          `${this.pc.yellow('\u2713')} ${title} ${this.pc.yellow('(flaky)')} ${this.pc.dim(`[${target}] ${formatDuration(duration)}${aiSuffix}`)}`,
        );
        break;
      case 'skipped':
        this.skipped += 1;
        this.output.write(
          `${this.pc.cyan('-')} ${title} ${this.pc.dim(`[${target}] skipped: ${bounded(result.skip?.reason ?? '')}`)}`,
        );
        break;
      default: {
        this.failed += 1;
        this.output.write(
          `${this.pc.red('\u2717')} ${title} ${this.pc.dim(`[${target}] ${result.status} ${formatDuration(duration)}${aiSuffix}`)}`,
        );
        const error = result.attempts[result.attempts.length - 1]?.error;
        if (error !== undefined) {
          for (const line of bounded(error.message).split('\n')) {
            this.output.write(`    ${this.pc.red(line)}`);
          }
          this.writeFailureLocation(error.stack);
        }
      }
    }
    this.status.redraw();
  }

  /** Names the user's failing line and renders a small code frame around it. */
  private writeFailureLocation(stack: string | undefined): void {
    if (this.projectRoot === undefined) return;
    const frame = userFrame(stack, this.projectRoot);
    if (frame === undefined) return;
    const relative = path.relative(this.projectRoot, frame.file);
    this.output.write('');
    this.output.write(
      `    ${this.pc.dim('at')} ${this.pc.cyan(`${bounded(relative)}:${frame.line}:${frame.column}`)}`,
    );
    for (const line of codeFrame(frame)) this.output.write(`    ${line}`);
  }

  onRunEnd(info: {
    status: string;
    exitCode: number;
    reportPath?: string;
    errors?: readonly RunError[];
  }): void {
    this.status.erase();
    // Run-level errors never reach onResult: they abort before, between, or
    // after test execution. Without this the console shows only a bare exit
    // code and the reason lives solely in report.json.
    for (const { error } of info.errors ?? []) {
      this.output.write('');
      const phase = error.phase === undefined ? '' : ` ${this.pc.dim(`(${error.phase})`)}`;
      this.output.write(`${this.pc.red(`\u2717 ${error.category} error`)} ${this.pc.dim(error.code)}${phase}`);
      for (const line of bounded(error.message).split('\n')) {
        this.output.write(`    ${this.pc.red(line)}`);
      }
    }
    const parts = [
      this.passed > 0 ? this.pc.green(`${this.passed} passed`) : undefined,
      this.failed > 0 ? this.pc.red(`${this.failed} failed`) : undefined,
      this.flaky > 0 ? this.pc.yellow(`${this.flaky} flaky`) : undefined,
      this.skipped > 0 ? this.pc.cyan(`${this.skipped} skipped`) : undefined,
    ].filter((part) => part !== undefined);
    this.output.write('');
    this.output.write(parts.length > 0 ? parts.join(this.pc.dim(' \u00b7 ')) : this.pc.dim('no tests executed'));
    const ai = aiSegment(this.runAi);
    if (ai !== undefined) {
      this.output.write(this.pc.dim(`${ai} \u00b7 ${this.runAi.calls} model calls`));
    }
    this.output.write(this.pc.dim(`report: ${info.reportPath ?? '(not written)'}`));
  }
}

/**
 * Adapts the list reporter onto the run's event spine: one dispatch per fact,
 * so the CLI renders exactly what a host sink receives and the two can never
 * drift. Run-level errors are accumulated here because the reporter prints
 * them once, at the end, while the stream carries them as they happen.
 */
export function listReporterSink(reporter: ListReporter): RunEventSink {
  const errors: RunError[] = [];
  return (event) => {
    switch (event.type) {
      case 'run-started':
        reporter.onRunStart({
          runId: event.runId,
          targets: event.targets,
          ci: event.ci,
          projectRoot: event.projectRoot,
        });
        break;
      case 'plan':
        reporter.onPlan({ total: event.total });
        break;
      case 'test-started':
        reporter.onTestStart({ id: event.testId, title: event.title, target: event.target });
        break;
      case 'step':
        reporter.onProgress({ testId: event.testId, target: event.target, progress: event.progress });
        break;
      case 'test-finished':
        reporter.onResult(event.result);
        break;
      case 'serial-group':
        reporter.onSerialGroup(event.group);
        break;
      case 'run-error':
        errors.push({ error: event.error });
        break;
      case 'run-finished':
        reporter.onRunEnd({
          status: event.status,
          exitCode: event.exitCode,
          ...(event.reportPath === undefined ? {} : { reportPath: event.reportPath }),
          errors,
        });
        break;
    }
  };
}
