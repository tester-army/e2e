/**
 * The `--repeat-each` tally the list and markdown reporters print: every run
 * of one test, target, and agent side by side, so a flake reads as `3/5
 * passed` with the runs that did not, instead of five results to count.
 */

/** One run of a repeated test. `code` is the error code of a run that did not pass. */
export interface RepeatRun {
  readonly repeat: number;
  readonly status: string;
  readonly code?: string | undefined;
}

/** Every run of one test, target, and agent, in repeat order. */
export interface RepeatGroup {
  readonly label: string;
  readonly runs: readonly RepeatRun[];
  /** Runs that passed on their first attempt; a flaky run needed a retry and does not count. */
  readonly passed: number;
}

/**
 * Groups runs by `key`, keeping only tests that ran more than once and did
 * not skip every run, in first-seen order.
 */
export function repeatGroups<T>(
  items: readonly T[],
  describe: (item: T) => { readonly key: string; readonly label: string; readonly run: RepeatRun },
): RepeatGroup[] {
  const groups = new Map<string, { label: string; runs: RepeatRun[] }>();
  for (const item of items) {
    const { key, label, run } = describe(item);
    const group = groups.get(key) ?? { label, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.runs.length > 1 && group.runs.some((run) => run.status !== 'skipped'))
    .map((group) => {
      const runs = group.runs.toSorted((a, b) => a.repeat - b.repeat);
      return { label: group.label, runs, passed: runs.filter((run) => run.status === 'passed').length };
    });
}

/** `2 of 3 tests passed all 5 runs`; the run count is the most any test had. */
export function repeatSummary(groups: readonly RepeatGroup[]): string {
  const stable = groups.filter((group) => group.passed === group.runs.length).length;
  const runs = Math.max(...groups.map((group) => group.runs.length));
  return `${stable} of ${groups.length} test${groups.length === 1 ? '' : 's'} passed all ${runs} runs`;
}

/** A run that did not pass, in a word: its error code, or `flaky` with the code its retry recovered from. */
function outcomeOf(run: RepeatRun): string {
  if (run.status === 'flaky') return run.code === undefined ? 'flaky' : `flaky (${run.code})`;
  return run.code ?? run.status;
}

/** `3/5 passed · repeat 0 ASSERTION_FAILED · repeat 2 flaky`, naming each run that did not pass. */
export function repeatLine(group: RepeatGroup): string {
  const misses = group.runs
    .filter((run) => run.status !== 'passed')
    .map((run) => `repeat ${run.repeat} ${outcomeOf(run)}`);
  return [`${group.passed}/${group.runs.length} passed`, ...misses].join(' · ');
}
