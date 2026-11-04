import type { CacheCounts } from '../digest.ts';
import type { TestInsight } from '../analyze.ts';

/** Drops terminal controls (C0, DEL, C1) and bidi overrides, so a test title cannot repaint the terminal or reorder a line. */
export function plain(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ');
}

/** The verdicts that need someone to look, in report order. */
export const UNHEALTHY = new Set(['broken', 'failing', 'flaky']);

/** Where a result ran: the target, then the agent when it is not the default one. */
export function where(test: Pick<TestInsight, 'targetId' | 'agent'>): string {
  return plain(test.agent === 'default' ? test.targetId : `${test.targetId} · ${test.agent}`);
}

/** The flake-rate cell: a failure streak for a test that is failing now, else the rate. */
export function rateCell(test: TestInsight): string {
  if (test.verdict === 'broken' || test.verdict === 'failing') return `${test.failStreak} in a row`;
  return percent(test.flakeEvents, test.runs - test.infraFailures);
}

/** `describe › test`, controls stripped. */
export function title(test: Pick<TestInsight, 'titlePath'>): string {
  return plain(test.titlePath.join(' › '));
}

/** An ISO timestamp as `2026-11-03 19:20 UTC`; the input unchanged when it does not parse. */
export function when(iso: string | undefined): string {
  if (iso === undefined) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return plain(iso);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A share of a whole as `12%`; `-` when the whole is zero. */
export function percent(part: number, whole: number): string {
  if (whole === 0) return '-';
  return `${Math.round((part / whole) * 100)}%`;
}

/** Milliseconds as `850ms`, `4.2s`, or `3m 05s`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Dollars with enough digits to tell model calls apart; `-` when the provider reported no cost. */
export function dollars(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Token counts as `840`, `12.3k`, `4.1M`. */
export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `4 replayed · 1 handed off · 2 missed`, the terminal's own cache words. */
export function cacheLine(cache: CacheCounts): string {
  return `${cache.replayed} replayed · ${cache.handedOff} handed off · ${cache.missed} missed`;
}

/** The miss reasons, most frequent first: `no-entry ×3, end-mismatch ×1`. */
export function reasonsLine(cache: CacheCounts, limit = 3): string {
  return Object.entries(cache.reasons)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => `${plain(reason)} ×${count}`)
    .join(', ');
}

/** Agent-step tests sorted by how often they had to call the model: the ones worth re-recording or rewriting. */
export function cacheHotspots(tests: readonly TestInsight[], limit = 10): TestInsight[] {
  return tests
    .filter((test) => test.cache.missed + test.cache.handedOff > 0)
    .toSorted((a, b) => b.cache.missed + b.cache.handedOff - (a.cache.missed + a.cache.handedOff) || b.modelCalls - a.modelCalls)
    .slice(0, limit);
}

/** Tests with a reported cost, most expensive first. */
export function costliest(tests: readonly TestInsight[], limit = 10): TestInsight[] {
  return tests
    .filter((test) => (test.costUsd ?? 0) > 0 || test.tokens > 0)
    .toSorted((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens)
    .slice(0, limit);
}

/** Tests by 95th percentile duration, slowest first. */
export function slowest(tests: readonly TestInsight[], limit = 10): TestInsight[] {
  return [...tests].toSorted((a, b) => b.p95DurationMs - a.p95DurationMs).slice(0, limit);
}

/** How a test's results split, as one cell: `9 pass · 1 retry · 2 fail`. */
export function outcomeLine(test: TestInsight): string {
  const parts = [`${test.passes} pass`];
  if (test.retryPasses > 0) parts.push(`${test.retryPasses} retry`);
  if (test.failures > 0) parts.push(`${test.failures} fail`);
  if (test.infraFailures > 0) parts.push(`${test.infraFailures} infra`);
  return parts.join(' · ');
}
