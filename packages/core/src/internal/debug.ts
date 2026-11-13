/** Opt-in phase timing collection for `e2e run --debug`. */

interface DebugEntry {
  totalMs: number;
  count: number;
  maxMs: number;
}

/** One aggregated phase, JSON-serializable so workers can ship it over IPC. */
export interface DebugEntrySnapshot extends DebugEntry {
  readonly label: string;
}

/** Everything one trace collected, JSON-serializable for the worker channel. */
export interface DebugSnapshot {
  readonly entries: readonly DebugEntrySnapshot[];
}

/**
 * Aggregates named phase durations for one run. When disabled every method is
 * a near-zero pass-through, so call sites never need to branch.
 */
export class DebugTrace {
  private readonly entries = new Map<string, DebugEntry>();
  private readonly startedMs = Date.now();

  constructor(readonly enabled: boolean) {}

  /** Records one completed phase duration under a label. */
  record(label: string, durationMs: number): void {
    if (!this.enabled) return;
    const entry = this.entries.get(label);
    if (entry === undefined) {
      this.entries.set(label, { totalMs: durationMs, count: 1, maxMs: durationMs });
      return;
    }
    entry.totalMs += durationMs;
    entry.count += 1;
    if (durationMs > entry.maxMs) entry.maxMs = durationMs;
  }

  /** Times one async phase and records it, rethrowing any failure. */
  async time<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (!this.enabled) return work();
    const started = Date.now();
    try {
      return await work();
    } finally {
      this.record(label, Date.now() - started);
    }
  }

  /** Returns everything recorded so far and resets, for transport to another trace. */
  drain(): DebugSnapshot {
    const snapshot: DebugSnapshot = {
      entries: [...this.entries.entries()].map(([label, entry]) => ({ label, ...entry })),
    };
    this.entries.clear();
    return snapshot;
  }

  /** Folds a drained snapshot from another trace into this one. */
  merge(snapshot: DebugSnapshot): void {
    if (!this.enabled) return;
    for (const incoming of snapshot.entries) {
      const entry = this.entries.get(incoming.label);
      if (entry === undefined) {
        this.entries.set(incoming.label, {
          totalMs: incoming.totalMs,
          count: incoming.count,
          maxMs: incoming.maxMs,
        });
        continue;
      }
      entry.totalMs += incoming.totalMs;
      entry.count += incoming.count;
      if (incoming.maxMs > entry.maxMs) entry.maxMs = incoming.maxMs;
    }
  }

  /** Formats aggregated timings as one aligned table, phases sorted by total time. */
  summary(): string {
    const rows = [...this.entries.entries()]
      .toSorted((left, right) => right[1].totalMs - left[1].totalMs)
      .map(([label, entry]) => [
        label,
        String(entry.count),
        formatMs(entry.totalMs),
        formatMs(entry.totalMs / entry.count),
        formatMs(entry.maxMs),
      ]);
    return table(
      `[e2e debug] phase timings (wall ${formatMs(Date.now() - this.startedMs)})`,
      ['phase', 'count', 'total', 'avg', 'max'],
      rows,
      '(no phases recorded)',
    );
  }
}

/**
 * Renders one aligned table. The first column is left-aligned and the rest are
 * right-aligned, which suits numbers; `leftAligned` names any further columns
 * that hold prose and would be unreadable pushed to the right.
 */
export function table(
  title: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
  empty: string,
  leftAligned: ReadonlySet<number> = new Set(),
): string {
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: readonly string[]): string =>
    `  ${row
      .map((cell, column) =>
        column === 0 || leftAligned.has(column)
          ? cell.padEnd(widths[column] ?? 0)
          : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd()}`;
  const body = rows.length === 0 ? [`  ${empty}`] : rows.map(line);
  return [title, line(header), ...body, ''].join('\n');
}

export function formatMs(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}
