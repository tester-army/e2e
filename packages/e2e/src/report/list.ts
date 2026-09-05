/** Human-readable list reporter (spec 06-cli.md). */

import path from 'node:path';
import picocolors from 'picocolors';
import { sanitizeText, truncateUtf8, type SerializedError } from '../internal/errors.ts';
import { collapseText } from '../internal/text.ts';
import type { RunEventFact, RunEventOf, RunEventResult } from '../run/events.ts';
import type { SerialGroupRecord } from '../run/records.ts';
import type { StepEvent, StepRecord } from '../run/steps.ts';
import { codeFrame, userFrame } from './code-frame.ts';
import { LiveStatus } from './live-status.ts';

const MAX_FIELD_BYTES = 8192;

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_BYTES = 72;

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
  const flat = collapseText(label);
  const shown = truncateUtf8(flat, MAX_STEP_LABEL_BYTES);
  return `"${shown}${shown === flat ? '' : '…'}"`;
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
 * through the `serial-group` event.
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
 * Live tail for one step event. Model and backend calls are the ones worth a
 * glance (`tool:` prefixes come from executor tool accounting); polls and
 * policy decisions stay quiet.
 */
function eventTail(event: StepEvent): string | undefined {
  if (event.kind === 'model') {
    const tokens =
      event.count !== undefined && event.count > 0 ? ` · ${formatTokens(event.count)} tokens` : '';
    return `model turn ${formatDuration(event.durationMs)}${tokens}`;
  }
  if (event.kind === 'backend') {
    const name = sanitizeText(event.name ?? 'backend').replace(/^tool:/, '');
    const failed = event.status === 'passed' ? '' : ' ✗';
    return `${truncateUtf8(name, 40)} ${formatDuration(event.durationMs)}${failed}`;
  }
  return undefined;
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
  /** Rolling window of the running step's latest model and backend calls. */
  private readonly liveEvents = new Map<string, string[]>();
  /** Pairs whose permanent header line has been written. */
  private readonly headerPrinted = new Set<string>();
  /** Run-wide model usage, summed from every reported result. */
  private readonly runAi: AiUsage = { calls: 0, tokens: 0, costUsd: undefined };
  /** Colors follow live rendering: non-interactive sinks get plain text. */
  private readonly pc: ReturnType<typeof picocolors.createColors>;
  /** Run-level errors, printed once at the end; the stream carries them as they happen. */
  private readonly errors: SerializedError[] = [];

  constructor(
    private readonly output: ListReporterOutput = DEFAULT_OUTPUT,
    options: { live?: boolean } = {},
  ) {
    const live = (options.live ?? process.stdout.isTTY === true) && output.raw !== undefined;
    this.status = new LiveStatus(live ? output.raw?.bind(output) : undefined);
    this.pc = picocolors.createColors(live);
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
        this.status.plan(event.total);
        break;
      case 'notice':
        this.writeAboveStatus(`${this.pc.dim('ℹ')} ${event.message}`);
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
      case 'analysis':
        this.analysis(event);
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

  /** Acknowledged immediately, so a bounded teardown is not mistaken for a hang. */
  private runInterrupted(event: RunEventOf<'run-interrupted'>): void {
    this.writeAboveStatus(
      this.pc.yellow(
        event.mode === 'graceful'
          ? 'interrupted: stopping the running test and tearing down (interrupt again to force)'
          : 'interrupted again: tearing every worker down now',
      ),
    );
  }

  private runStarted(event: RunEventOf<'run-started'>): void {
    this.projectRoot = event.projectRoot;
    this.output.write(
      this.pc.dim(
        `e2e run ${event.runId} (targets: ${event.targets.join(', ')})${event.ci ? ' [CI]' : ''}`,
      ),
    );
  }

  /** A worker began one test-target pair: show it in the live status block. */
  private testStarted(event: RunEventOf<'test-started'>): void {
    const key = `${event.testId}@${event.target}`;
    const base = `${bounded(event.title)} ${this.pc.dim(`[${event.target}]`)}`;
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
   * line per step, one line per model or backend call, and a step summary -
   * the scrollback of a run reads without `--debug`. With parallel tests the
   * stream would interleave, so each pair instead shows its current step and
   * latest calls transiently in the live block.
   */
  private step(event: RunEventOf<'step'>): void {
    const key = `${event.testId}@${event.target}`;
    const base = this.liveBase.get(key);
    if (base === undefined) return;
    const { progress } = event;
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
  private serialGroup(group: SerialGroupRecord): void {
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

  private testFinished(result: RunEventResult): void {
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

  /**
   * A failed pair's analysis, printed as it lands — after that pair's failure
   * block and possibly after later results, since analysis runs beside the
   * remaining tests. The header names the test again so the verdict reads on
   * its own.
   */
  private analysis(event: RunEventOf<'analysis'>): void {
    const { analysis } = event;
    const head = `${this.pc.dim('\u21b3 analysis')} ${bounded(event.title)} ${this.pc.dim(`[${event.target}]`)}`;
    if (analysis.status === 'unavailable') {
      this.writeAboveStatus(
        `${head} ${this.pc.dim(`unavailable (${analysis.reason}): ${bounded(analysis.message)}`)}`,
      );
      return;
    }
    const paint =
      analysis.classification === 'app-bug'
        ? this.pc.red
        : analysis.classification === 'unknown'
          ? this.pc.dim
          : this.pc.yellow;
    const model = analysis.model === undefined ? '' : ` \u00b7 ${analysis.model.provider}/${analysis.model.model}`;
    this.writeAboveStatus(
      `${head} ${paint(analysis.classification)} ${this.pc.dim(
        `\u00b7 ${analysis.confidence} confidence${model} \u00b7 ${formatDuration(analysis.durationMs)}`,
      )}`,
    );
    for (const line of bounded(analysis.summary).split('\n')) this.writeAboveStatus(`    ${line}`);
    for (const item of analysis.evidence) this.writeAboveStatus(`    ${this.pc.dim(`- ${bounded(item)}`)}`);
    if (analysis.suggestedFix !== undefined) {
      this.writeAboveStatus(`    ${this.pc.cyan('fix:')} ${bounded(analysis.suggestedFix)}`);
    }
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

  private runFinished(event: RunEventOf<'run-finished'>): void {
    this.status.stop();
    // Run-level errors never arrive as results: they abort before, between, or
    // after test execution. Without this the console shows only a bare exit
    // code and the reason lives solely in report.json.
    for (const error of this.errors) {
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
    this.output.write(this.pc.dim(`report: ${event.reportPath ?? '(not written)'}`));
    if (event.aiTracePath !== undefined) {
      this.output.write(
        this.pc.dim(`ai trace: ${event.aiTracePath} · open with: npx unbox-ai ${event.aiTracePath}`),
      );
    }
  }
}

