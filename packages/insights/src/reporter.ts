import path from 'node:path';
import type { FinishedRun, Reporter, ReporterSummary } from 'e2e';
import { analyze } from './analyze.ts';
import { digestReport } from './digest.ts';
import { appendRun, HISTORY_FILE } from './store.ts';

/** Where the history lives when nothing says otherwise, relative to the project root. */
export const DEFAULT_HISTORY_DIR = '.e2e/history';

export interface InsightsOptions {
  /** The history directory, relative to the project root; default `.e2e/history`. Persist it between CI runs. */
  dir?: string;
  /** Runs the history keeps, newest last; default 200. */
  keep?: number;
}

/**
 * The insights reporter. Each finished run appends one compact record to
 * `<dir>/runs.jsonl`, and the summary gains one row with the flaky and
 * broken tests across the history:
 *
 * ```ts
 * import { insights } from '@e2e-dev/insights';
 * export default { targets, reporters: ['list', insights()] } satisfies E2EConfig;
 * ```
 *
 * The record keeps ids, titles, statuses, timings, model counters, and error
 * codes, never a step label, an error message, or app text. An `explore` run
 * and a run that executed no test are not recorded. Constructing it has no
 * side effects; the file is touched only when the run finishes.
 */
export function insights(options: InsightsOptions = {}): Reporter {
  const dir = options.dir ?? DEFAULT_HISTORY_DIR;
  const keep = options.keep ?? 200;
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('insights({ dir }) must be a non-empty path');
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError(`insights({ keep }) must be a positive integer, got ${keep}`);
  return {
    name: 'insights',
    onRunFinished: (run) => recordRun(run, dir, keep),
  };
}

async function recordRun(run: FinishedRun, dir: string, keep: number): Promise<ReporterSummary | void> {
  const report = run.report;
  if (report.run.explore !== undefined || report.run.summary.executed === 0) return;
  const file = path.resolve(run.projectRoot, dir, HISTORY_FILE);
  const history = await appendRun(file, digestReport(report), keep);
  const result = analyze(history);
  const shown = path.relative(run.projectRoot, file).split(path.sep).join('/');
  const health =
    result.counts.broken + result.counts.failing + result.counts.flaky === 0
      ? 'no broken, failing, or flaky tests'
      : [
          result.counts.broken > 0 ? `${result.counts.broken} broken` : '',
          result.counts.failing > 0 ? `${result.counts.failing} failing` : '',
          result.counts.flaky > 0 ? `${result.counts.flaky} flaky` : '',
        ]
          .filter(Boolean)
          .join(' · ');
  return [{ label: 'Insights', text: `${health} over ${result.runs} runs (${shown})` }];
}
