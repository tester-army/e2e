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
type ReportSerialGroup = ReportRun['serialGroups'][number];
type ReportSummary = ReportRun['summary'];

/** Statuses that count as a failure of the run, the ones `--last-failed` runs again. */
const FAILED_STATUSES = new Set<ReportResult['status']>(['failed', 'timed-out', 'interrupted']);

/**
 * A test per target and agent, whatever its `--repeat-each` run: the identity
 * `--last-failed` selects by, so a rerun without the flag runs once a test any
 * repeat of which failed.
 */
function testKey(result: ReportResult): string {
  return [result.testId, result.targetId, result.agent].join('\u0000');
}

/**
 * The rerun's result with the run before's attempts in front of its own:
 * the same test's result there, and the further repeats the rerun has no
 * result of its own for. A pass after a failure there is flaky.
 */
function foldRerun(current: ReportResult, history: readonly ReportResult[]): ReportResult {
  if (history.length === 0) return current;
  const before = history.toSorted((a, b) => a.repeat - b.repeat);
  const attempts = [...before.flatMap((result) => result.attempts), ...current.attempts];
  const status = current.status === 'passed' && before.some((result) => FAILED_STATUSES.has(result.status)) ? 'flaky' : current.status;
  return { ...current, status, attempts };
}

/**
 * A serial group the rerun ran again, with the run before's attempts in front
 * of its own: a member's history is read off its group, so the first pass's
 * failure stays visible under a member that passed on the rerun.
 */
function foldGroup(current: ReportSerialGroup, before: ReportSerialGroup | undefined): ReportSerialGroup {
  if (before === undefined) return current;
  const attempts = [...before.attempts, ...current.attempts].map((attempt, index) => ({ ...attempt, index }));
  return { ...current, attempts };
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
 * The rerun folded into the run it selected from. A result the rerun has
 * under the same id is folded with it; a test the rerun left out keeps what
 * the run before said. Results the rerun has no id for at all, the further
 * repeats of a `--repeat-each` first pass a plain rerun ran once, fold into
 * the rerun's first result of that test, or stay as carried rows when the
 * rerun left the test out. A run before of another project leaves the rerun
 * as it is. The outcome is the rerun's unless a carried result failed, as a
 * test another filter kept out of the rerun can have: then the page is red,
 * since it lists a failure. The start is the run before's, so the footer's
 * duration spans both.
 */
export function foldLastRun(current: Report, lastRun: Report): Report {
  if (lastRun.run.project.id !== current.run.project.id) return current;
  const currentIds = new Set(current.run.results.map((result) => result.id));
  const beforeById = new Map(lastRun.run.results.map((result) => [result.id, result]));
  const leftovers = new Map<string, ReportResult[]>();
  for (const result of lastRun.run.results) {
    if (currentIds.has(result.id)) continue;
    const key = testKey(result);
    leftovers.set(key, [...(leftovers.get(key) ?? []), result]);
  }
  const firstOfKey = new Map<string, string>();
  for (const result of current.run.results.toSorted((a, b) => a.repeat - b.repeat)) {
    if (!firstOfKey.has(testKey(result))) firstOfKey.set(testKey(result), result.id);
  }

  const results: ReportResult[] = [];
  for (const result of current.run.results) {
    const before = beforeById.get(result.id);
    if (!result.selected) {
      results.push(before ?? result);
      continue;
    }
    const key = testKey(result);
    const extra = firstOfKey.get(key) === result.id ? (leftovers.get(key) ?? []) : [];
    if (extra.length > 0) leftovers.delete(key);
    results.push(foldRerun(result, before === undefined ? extra : [before, ...extra]));
  }
  for (const extra of leftovers.values()) results.push(...extra);

  const beforeGroups = new Map(lastRun.run.serialGroups.map((group) => [group.id, group]));
  const currentGroupIds = new Set(current.run.serialGroups.map((group) => group.id));
  const serialGroups = [
    ...lastRun.run.serialGroups.filter((group) => !currentGroupIds.has(group.id)),
    ...current.run.serialGroups.map((group) => foldGroup(group, beforeGroups.get(group.id))),
  ];

  const carriedFailure = results.some((result) => result.selected && FAILED_STATUSES.has(result.status));
  return {
    ...current,
    run: {
      ...current.run,
      status: carriedFailure && current.run.status === 'passed' ? 'failed' : current.run.status,
      exitCode: carriedFailure && current.run.exitCode === 0 ? 1 : current.run.exitCode,
      startedAt: lastRun.run.startedAt,
      serialGroups,
      results,
      summary: summarize(results, current.run.summary),
    },
  };
}
