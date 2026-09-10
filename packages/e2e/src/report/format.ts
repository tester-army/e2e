/**
 * Pure presentation helpers shared by the terminal reporters: colors, the
 * terminal width, durations, counters, and model-usage tallies. Stateless, so
 * the reporters own every decision about what to print and when.
 */

import { stripVTControlCharacters } from 'node:util';
import picocolors from 'picocolors';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import type { ResultStatus } from '../run/records.ts';
import type { StepRecord } from '../run/steps.ts';

/** A picocolors instance; the reporter decides whether it emits color. */
export type Colors = ReturnType<typeof picocolors.createColors>;

/** Glyphs shared by the list reporter's permanent lines and its live tree. */
export const F_POINTER = '❯';
export const F_CHECK = '✓';
export const F_CROSS = '×';

/** Every untrusted field is capped here before it reaches the terminal. */
const MAX_FIELD_BYTES = 8192;
const LONG_DASH = '⎯';
/** Width of the summary's right-aligned title column (`Test Files`). */
const TITLE_WIDTH = 11;

/**
 * Sanitized and bounded: the one form untrusted text takes on the terminal.
 * Tabs become spaces, since a tab's width depends on the column it lands in
 * and would break the live window's row accounting.
 */
export function bounded(text: string): string {
  return truncateUtf8(sanitizeText(text), MAX_FIELD_BYTES).replaceAll('\t', ' ');
}

/** Clips to `max` characters with an ellipsis; untouched when it fits. */
export function ellipsize(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** The terminal width; a pty without a size reports 0, which counts as unknown. */
export function terminalColumns(): number {
  return process.stdout.columns || 80;
}

/** The terminal height; a pty without a size reports 0, which counts as unknown. */
export function terminalRows(): number {
  return process.stdout.rows || 40;
}

/** vitest's duration format: whole milliseconds under a second, two decimals above. */
export function formatTime(ms: number): string {
  return ms > 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Wall-clock `HH:MM:SS` for the summary's `Start at` row. */
export function formatClock(date: Date): string {
  return date.toTimeString().split(' ')[0] ?? '';
}

/** Compact token count: plain under a thousand, `12.4k`, then `4.2M`. */
export function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** USD with enough precision for sub-cent model calls. */
function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd < 0.1 ? 4 : 2)}`;
}

/** One padded summary title, right-aligned like vitest's `Test Files` column. */
export function padTitle(pc: Colors, title: string): string {
  return pc.dim(`${title.padStart(TITLE_WIDTH)}  `);
}

/**
 * The dashes of a full-width rule around `text`: centered, or with the text
 * pushed to the right edge as vitest draws `[1/3]` markers. Uncolored, so the
 * caller colors the dashes and the text independently.
 */
export function rule(text: string, align: 'center' | 'right'): { before: string; after: string } {
  const columns = terminalColumns();
  const width = visibleWidth(text);
  const after = align === 'center' ? Math.max(0, Math.ceil((columns - width) / 2)) : 1;
  const before = Math.max(0, columns - width - after);
  return { before: LONG_DASH.repeat(before), after: LONG_DASH.repeat(after) };
}

export interface Counters {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  total: number;
}

export function emptyCounters(): Counters {
  return { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0 };
}

/** The counter a result status lands in: every non-success status is a failure. */
export function statusBucket(status: ResultStatus): 'passed' | 'failed' | 'flaky' | 'skipped' {
  return status === 'passed' || status === 'flaky' || status === 'skipped' ? status : 'failed';
}

/** Counts results by bucket; `total` is the number of items. */
export function tally(items: readonly { readonly status: ResultStatus }[]): Counters {
  const counters = emptyCounters();
  for (const item of items) {
    counters[statusBucket(item.status)] += 1;
    counters.total += 1;
  }
  return counters;
}

/** A file's outcome from its tests: failed if any did, skipped if all did, else passed. */
export function fileOutcome(counters: Counters): 'passed' | 'failed' | 'skipped' {
  if (counters.failed > 0) return 'failed';
  if (counters.total > 0 && counters.skipped === counters.total) return 'skipped';
  return 'passed';
}

/** `2 failed | 10 passed | 1 flaky (13)` in vitest's colors and order. */
export function stateString(pc: Colors, counters: Counters): string {
  const parts = [
    counters.failed > 0 ? pc.bold(pc.red(`${counters.failed} failed`)) : undefined,
    pc.bold(pc.green(`${counters.passed} passed`)),
    counters.flaky > 0 ? pc.yellow(`${counters.flaky} flaky`) : undefined,
    counters.skipped > 0 ? pc.gray(`${counters.skipped} skipped`) : undefined,
  ].filter((part) => part !== undefined);
  return `${parts.join(pc.dim(' | '))}${pc.gray(` (${counters.total})`)}`;
}

export interface AiUsage {
  calls: number;
  /** Input plus output tokens. */
  tokens: number;
  /** Input tokens alone; the denominator of the cached share. */
  inputTokens: number;
  /** Input tokens the provider served from its prompt cache; part of `inputTokens`. */
  cachedTokens: number;
  costUsd: number | undefined;
}

export function emptyUsage(): AiUsage {
  return { calls: 0, tokens: 0, inputTokens: 0, cachedTokens: 0, costUsd: undefined };
}

export function addUsage(into: AiUsage, usage: AiUsage): void {
  into.calls += usage.calls;
  into.tokens += usage.tokens;
  into.inputTokens += usage.inputTokens;
  into.cachedTokens += usage.cachedTokens;
  if (usage.costUsd !== undefined) into.costUsd = (into.costUsd ?? 0) + usage.costUsd;
}

/** Accumulates the model usage of one step list into a running total. */
function addStepsUsage(usage: AiUsage, steps: readonly StepRecord[]): void {
  for (const step of steps) {
    if (step.model === undefined) continue;
    usage.calls += step.model.calls;
    usage.tokens += step.model.inputTokens + step.model.outputTokens;
    usage.inputTokens += step.model.inputTokens;
    usage.cachedTokens += step.model.cacheReadTokens ?? 0;
    if (step.model.estimatedCostUsd !== undefined) {
      usage.costUsd = (usage.costUsd ?? 0) + step.model.estimatedCostUsd;
    }
  }
}

/** The model usage of several step lists summed. */
export function stepsUsage(stepLists: readonly (readonly StepRecord[])[]): AiUsage {
  const usage = emptyUsage();
  for (const steps of stepLists) addStepsUsage(usage, steps);
  return usage;
}

/** The model usage of several items summed. */
export function sumUsage(items: readonly { readonly usage: AiUsage }[]): AiUsage {
  const total = emptyUsage();
  for (const item of items) addUsage(total, item.usage);
  return total;
}

/**
 * Tokens, cached share, and cost, `12.4k tokens · 38% cached · $0.01`, or
 * undefined when no model was used. The cached share is the part of the input
 * the provider served from its prompt cache, and appears only when that part
 * is not empty.
 */
export function usageText(usage: AiUsage): string | undefined {
  if (usage.calls === 0) return undefined;
  const cached =
    usage.cachedTokens > 0 && usage.inputTokens > 0
      ? ` · ${String(Math.round((usage.cachedTokens / usage.inputTokens) * 100))}% cached`
      : '';
  const cost = usage.costUsd === undefined ? '' : ` · ${formatCost(usage.costUsd)}`;
  return `${formatTokens(usage.tokens)} tokens${cached}${cost}`;
}

/** `usageText` labeled `ai …` for lines where nothing else names it. */
export function aiSegment(usage: AiUsage): string | undefined {
  const text = usageText(usage);
  return text === undefined ? undefined : `ai ${text}`;
}

/** Printed width of a line, ANSI sequences excluded. */
export function visibleWidth(text: string): number {
  return [...stripVTControlCharacters(text)].length;
}
