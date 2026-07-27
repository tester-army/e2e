/** Opt-in phase timing collection for `e2e run --debug`. */

interface DebugEntry {
  totalMs: number;
  count: number;
  maxMs: number;
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

  /** Formats aggregated timings as an aligned table, sorted by total time. */
  summary(): string {
    const rows = [...this.entries.entries()]
      .toSorted((left, right) => right[1].totalMs - left[1].totalMs)
      .map(([label, entry]) => ({
        label,
        count: String(entry.count),
        total: formatMs(entry.totalMs),
        avg: formatMs(entry.totalMs / entry.count),
        max: formatMs(entry.maxMs),
      }));
    const header = { label: 'phase', count: 'count', total: 'total', avg: 'avg', max: 'max' };
    const width = (key: keyof typeof header): number =>
      Math.max(header[key].length, ...rows.map((row) => row[key].length));
    const widths = {
      label: width('label'),
      count: width('count'),
      total: width('total'),
      avg: width('avg'),
      max: width('max'),
    };
    const line = (row: typeof header): string =>
      `  ${row.label.padEnd(widths.label)}  ${row.count.padStart(widths.count)}  ${row.total.padStart(
        widths.total,
      )}  ${row.avg.padStart(widths.avg)}  ${row.max.padStart(widths.max)}`;
    const body = rows.length === 0 ? ['  (no phases recorded)'] : rows.map(line);
    return [
      `[e2e debug] phase timings (wall ${formatMs(Date.now() - this.startedMs)})`,
      line(header),
      ...body,
      '',
    ].join('\n');
  }
}

function formatMs(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}
