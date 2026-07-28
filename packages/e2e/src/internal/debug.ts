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

/** One agent invocation's timing breakdown, in execution order. */
export interface DebugStepSnapshot {
  /** Public API plus the caller's instruction, e.g. `agent.tap "the Sign in button"`. */
  readonly label: string;
  readonly totalMs: number;
  readonly modelMs: number;
  readonly observeMs: number;
  readonly actionMs: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Gateway-reported request cost; absent when the provider reports none. */
  readonly costUsd?: number;
  /** Model that served this step, e.g. `google/gemini-3-flash`; absent when no call was made. */
  readonly model?: string;
}

/** Everything one trace collected, JSON-serializable for the worker channel. */
export interface DebugSnapshot {
  readonly entries: readonly DebugEntrySnapshot[];
  readonly steps: readonly DebugStepSnapshot[];
}

/**
 * Aggregates named phase durations for one run. When disabled every method is
 * a near-zero pass-through, so call sites never need to branch.
 */
export class DebugTrace {
  private readonly entries = new Map<string, DebugEntry>();
  private readonly steps: DebugStepSnapshot[] = [];
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

  /** Records one finished agent invocation; steps keep execution order. */
  recordStep(step: DebugStepSnapshot): void {
    if (!this.enabled) return;
    this.steps.push(step);
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
      steps: [...this.steps],
    };
    this.entries.clear();
    this.steps.length = 0;
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
    this.steps.push(...snapshot.steps);
  }

  /** Formats aggregated timings as aligned tables, phases sorted by total time. */
  summary(): string {
    const sections = [this.phaseTable()];
    if (this.steps.length > 0) sections.push(this.stepTable());
    return sections.join('\n');
  }

  private phaseTable(): string {
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

  private stepTable(): string {
    const models = new Set(
      this.steps.map((step) => step.model).filter((model): model is string => model !== undefined),
    );
    const mixedModels = models.size > 1;
    const rows = this.steps.map((step) => [
      truncate(step.label, 64),
      ...(mixedModels ? [step.model ?? '-'] : []),
      formatMs(step.totalMs),
      formatMs(step.modelMs),
      formatMs(step.observeMs),
      formatMs(step.actionMs),
      String(step.modelCalls),
      `${String(step.inputTokens)}/${String(step.outputTokens)}`,
      step.costUsd === undefined ? '-' : formatUsd(step.costUsd),
    ]);
    const knownCosts = this.steps
      .map((step) => step.costUsd)
      .filter((cost): cost is number => cost !== undefined);
    const total =
      knownCosts.length === 0
        ? ''
        : `, total ${formatUsd(knownCosts.reduce((sum, cost) => sum + cost, 0))}${
            knownCosts.length < this.steps.length ? '+' : ''
          }`;
    const sharedModel = mixedModels || models.size === 0 ? '' : `, model ${[...models][0] ?? ''}`;
    return table(
      `[e2e debug] agent steps (execution order${sharedModel}${total})`,
      [
        'step',
        ...(mixedModels ? ['via'] : []),
        'total',
        'model',
        'observe',
        'action',
        'calls',
        'tokens in/out',
        'cost',
      ],
      rows,
      '(no agent steps recorded)',
    );
  }
}

/** Renders one aligned table: first column left-aligned, the rest right-aligned. */
function table(
  title: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
  empty: string,
): string {
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: readonly string[]): string =>
    `  ${row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')}`;
  const body = rows.length === 0 ? [`  ${empty}`] : rows.map(line);
  return [title, line(header), ...body, ''].join('\n');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatUsd(value: number): string {
  const digits = value >= 0.1 ? 2 : 6;
  const trimmed = value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `$${trimmed}`;
}

function formatMs(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}
