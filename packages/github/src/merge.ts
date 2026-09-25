/**
 * A `--last-failed` rerun and the run it selected from, as one report. The
 * rerun's document lists every test the run before it passed as unselected,
 * so the page would show only the few tests it ran again; folding the two
 * gives the comment the whole suite: carried results for the tests the rerun
 * left out, the rerun's results for the rest, and a test that failed and then
 * passed reads as flaky with both runs' attempts. Rendering only: nothing
 * here is written back to a report file.
 */

import type { Report } from 'e2e';

type ReportRun = Report['run'];
type ReportResult = ReportRun['results'][number];
type ReportSummary = ReportRun['summary'];

/** Statuses that count as a failure of the run, the ones `--last-failed` runs again. */
const FAILED_STATUSES = new Set<ReportResult['status']>(['failed', 'timed-out', 'interrupted']);

/** One result of the rerun against the same test's result in the run before. */
function foldResult(current: ReportResult, before: ReportResult | undefined): ReportResult {
  if (before === undefined) return current;
  // A test the rerun left out keeps what the run before said about it.
  if (!current.selected) return before;
  const attempts = [...before.attempts, ...current.attempts];
  const status = current.status === 'passed' && FAILED_STATUSES.has(before.status) ? 'flaky' : current.status;
  return { ...current, status, attempts };
}

/** The counts the way the runner tallies them, over the folded results. */
function summarize(results: readonly ReportResult[], base: ReportSummary): ReportSummary {
  const summary: ReportSummary = { ...base, discovered: results.length, selected: 0, executed: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const result of results) {
    if (result.selected) summary.selected += 1;
    if (result.attempts.length > 0 || (result.serialGroupId !== undefined && result.status !== 'skipped')) summary.executed += 1;
    if (result.status === 'passed') summary.passed += 1;
    else if (result.status === 'flaky') summary.flaky += 1;
    else if (FAILED_STATUSES.has(result.status)) summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/**
 * The rerun folded into the run it selected from. Results are matched by id,
 * so a test is folded per target, agent, and repeat; a result the run before
 * lacks, or a run before of another project, leaves the rerun as it is. The
 * run's status, exit code, and errors stay the rerun's: the tests it left out
 * are exactly the ones that did not fail, so it decides the outcome. The
 * start is the run before's, so the footer's duration spans both.
 */
export function foldLastRun(current: Report, lastRun: Report): Report {
  if (lastRun.run.project.id !== current.run.project.id) return current;
  const before = new Map(lastRun.run.results.map((result) => [result.id, result]));
  const results = current.run.results.map((result) => foldResult(result, before.get(result.id)));
  const groupIds = new Set(current.run.serialGroups.map((group) => group.id));
  const serialGroups = [...lastRun.run.serialGroups.filter((group) => !groupIds.has(group.id)), ...current.run.serialGroups];
  return {
    ...current,
    run: {
      ...current.run,
      startedAt: lastRun.run.startedAt,
      serialGroups,
      results,
      summary: summarize(results, current.run.summary),
    },
  };
}
