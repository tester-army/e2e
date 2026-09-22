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

/**
 * Clips to `max` code points with an ellipsis; untouched when it fits. For
 * text measured in characters (a markdown cell); a terminal row budget is
 * `fitColumns`.
 */
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
export function formatCost(costUsd: number): string {
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

/**
 * How the trace cache handled a run's agent steps, by step: replayed whole
 * with no model turn, replayed in part before the model took over, or missed.
 * A run with the cache off records no cache detail and tallies nothing.
 */
export interface CacheTally {
  replayed: number;
  handedOff: number;
  missed: number;
}

export function emptyCacheTally(): CacheTally {
  return { replayed: 0, handedOff: 0, missed: 0 };
}

export function addCacheTally(into: CacheTally, counts: CacheTally): void {
  into.replayed += counts.replayed;
  into.handedOff += counts.handedOff;
  into.missed += counts.missed;
}

/** The trace cache's part in several step lists, by step. */
export function stepsCacheTally(stepLists: readonly (readonly StepRecord[])[]): CacheTally {
  const counts = emptyCacheTally();
  for (const steps of stepLists) {
    for (const step of steps) {
      switch (step.cache?.mode) {
        case 'self-finalized':
          counts.replayed += 1;
          break;
        case 'agent-concluded':
          counts.handedOff += 1;
          break;
        case 'missed':
          counts.missed += 1;
          break;
        case undefined:
          break;
      }
    }
  }
  return counts;
}

/**
 * `9 replayed · 2 handed off · 4 missed`, zero counts left out, or undefined
 * when no step went through the trace cache.
 */
export function cacheText(pc: Colors, counts: CacheTally): string | undefined {
  const parts = [
    counts.replayed > 0 ? pc.green(`${counts.replayed} replayed`) : undefined,
    counts.handedOff > 0 ? pc.yellow(`${counts.handedOff} handed off`) : undefined,
    counts.missed > 0 ? `${counts.missed} missed` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(pc.dim(' · '));
}

/** `usageText` labeled `ai …` for lines where nothing else names it. */
export function aiSegment(usage: AiUsage): string | undefined {
  const text = usageText(usage);
  return text === undefined ? undefined : `ai ${text}`;
}

/**
 * Code point ranges a terminal paints two columns wide: East Asian wide and
 * fullwidth forms, and the symbols with default emoji presentation. wcwidth's
 * table trimmed to whole blocks; a grapheme cluster (a flag, a ZWJ sequence)
 * is the sum of its parts.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** Combining marks and format characters (a joiner, a variation selector) paint in the column of what they follow. */
const ZERO_WIDTH_PATTERN = /^[\p{M}\p{Cf}]$/u;
const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_TEXT = 0xfe0e;
const VARIATION_SELECTOR_EMOJI = 0xfe0f;
const COMBINING_KEYCAP = 0x20e3;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Terminal columns one code point paints on its own: 0 for a combining mark,
 * a format character, a Hangul medial or final jamo, or an emoji skin tone
 * modifier; 2 for East Asian wide and fullwidth forms and default emoji
 * presentation; else 1.
 */
function codePointColumns(codePoint: number): number {
  if (codePoint < 0x300) return 1;
  if (
    ZERO_WIDTH_PATTERN.test(String.fromCodePoint(codePoint)) ||
    (codePoint >= 0x1160 && codePoint <= 0x11ff) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  ) {
    return 0;
  }
  return WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end) ? 2 : 1;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/**
 * Terminal columns one grapheme cluster paints. An emoji sequence is two
 * whatever its length: a ZWJ sequence, a base with the emoji variation
 * selector, a keycap, or a regional indicator pair; the text variation
 * selector makes a symbol one. Anything else is the sum of its code points.
 */
function graphemeColumns(cluster: string): number {
  const codePoints = [...cluster].map((char) => char.codePointAt(0) ?? 0);
  if (codePoints.includes(VARIATION_SELECTOR_TEXT)) return 1;
  if (codePoints.some((codePoint) => codePoint === ZERO_WIDTH_JOINER || codePoint === VARIATION_SELECTOR_EMOJI || codePoint === COMBINING_KEYCAP)) return 2;
  if (codePoints.length === 2 && codePoints.every(isRegionalIndicator)) return 2;
  return codePoints.reduce((columns, codePoint) => columns + codePointColumns(codePoint), 0);
}

/** The grapheme clusters of `text`, each with the columns it paints; ANSI sequences count as text, so strip them first. */
export function graphemes(text: string): { readonly text: string; readonly columns: number }[] {
  return Array.from(SEGMENTER.segment(text), ({ segment }) => ({ text: segment, columns: graphemeColumns(segment) }));
}

/** Printed width of a line in terminal columns, ANSI sequences excluded. */
export function visibleWidth(text: string): number {
  return graphemes(stripVTControlCharacters(text)).reduce((width, cluster) => width + cluster.columns, 0);
}

/**
 * Clips terminal text to `columns` with the ellipsis inside the budget, whole
 * grapheme clusters only; untouched when it fits. Every budget derived from
 * the terminal width goes through this; `ellipsize` counts characters.
 */
export function fitColumns(text: string, columns: number): string {
  const clusters = graphemes(text);
  if (clusters.reduce((width, cluster) => width + cluster.columns, 0) <= columns) return text;
  const limit = Math.max(0, columns - 1);
  let width = 0;
  let out = '';
  for (const cluster of clusters) {
    if (width + cluster.columns > limit) break;
    out += cluster.text;
    width += cluster.columns;
  }
  return `${out}…`;
}

/**
 * The title suffix of a `--repeat-each` run past the first: ` (repeat #2)`;
 * empty for the first run, and for a report written before results carried
 * `repeat`, which the renderers may still be handed.
 */
export function repeatSuffix(repeat: number | undefined): string {
  return repeat === undefined || repeat === 0 ? '' : ` (repeat #${repeat})`;
}
