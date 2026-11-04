import type { CacheCounts, HistoryRun, HistoryTest } from './digest.ts';

/** One result reduced to what it says about the test: passed, passed on a retry, failed, or failed for an infrastructure reason. */
export type Outcome = 'pass' | 'retry' | 'fail' | 'infra';

/**
 * How a test has behaved across the window. `failing` means its latest
 * result failed but not yet `brokenAfter` times in a row: a fresh regression
 * or a flake, and the history cannot tell which yet.
 */
export type Verdict = 'broken' | 'failing' | 'flaky' | 'new' | 'stable';

/** Knobs of the analysis; every one has a default. */
export interface AnalyzeOptions {
  /** How many of the newest runs to look at; default 30. */
  window?: number;
  /** Runs a test needs before it gets a verdict other than `new`; default 5. */
  minRuns?: number;
  /**
   * Consecutive failures that make a test `broken`. A shorter failure run with
   * a pass on both sides counts as a flake; a longer one is a regression that
   * was fixed. Default 3.
   */
  brokenAfter?: number;
}

/** One test's behavior across the window, on one target and agent. */
export interface TestInsight {
  testId: string;
  targetId: string;
  agent: string;
  titlePath: string[];
  file: string;
  verdict: Verdict;
  /** Results in the window, `--repeat-each` repeats included. */
  runs: number;
  passes: number;
  /** Results that passed only on a retry after a test failure. */
  retryPasses: number;
  /** Results that failed or timed out for a test reason. */
  failures: number;
  /** Results that failed with an `infrastructure` or `configuration` error; they never count as flakes. */
  infraFailures: number;
  /**
   * Results that show the test is flaky: retry passes, failures in a run of
   * fewer than `brokenAfter` with a pass on both sides, and failures on a
   * clean commit the test also passed on.
   */
  flakeEvents: number;
  /** `flakeEvents` over the results that were not infrastructure failures, 0 through 1. */
  flakeRate: number;
  /** Clean commits on which the test both passed and failed: the app was the same, so the test was not. */
  sameCommitFlips: number;
  /** Consecutive failures at the end of the window. */
  failStreak: number;
  /** Each result's outcome, oldest first: what a per-run strip draws. */
  timeline: Outcome[];
  /** The most frequent error code among its failures. */
  topErrorCode?: string;
  lastStatus: HistoryTest['status'];
  lastSeen: string;
  medianDurationMs: number;
  p95DurationMs: number;
  modelCalls: number;
  tokens: number;
  costUsd?: number;
  cache: CacheCounts;
}

/** The whole analysis. */
export interface Insights {
  /** Runs analyzed, after the window cut. */
  runs: number;
  /** First and last run start in the window; absent for an empty history. */
  from?: string;
  to?: string;
  window: number;
  minRuns: number;
  /** Runs whose status was `passed`. */
  passedRuns: number;
  costUsd?: number;
  modelTokens: number;
  cache: CacheCounts;
  /** Broken, failing, flaky by rate, new, then stable. */
  tests: TestInsight[];
  counts: Record<Verdict, number>;
}

const VERDICT_ORDER: Record<Verdict, number> = { broken: 0, failing: 1, flaky: 2, new: 3, stable: 4 };
const INFRA_CATEGORIES = new Set(['infrastructure', 'configuration']);

/** Groups each test's results across runs and scores them. Pure: the same history always gives the same answer. */
export function analyze(history: readonly HistoryRun[], options: AnalyzeOptions = {}): Insights {
  const window = positiveInteger(options.window, 30);
  const minRuns = positiveInteger(options.minRuns, 5);
  const brokenAfter = positiveInteger(options.brokenAfter, 3);
  const runs = history.slice(-window);

  const samples = new Map<string, Sample[]>();
  for (const run of runs) {
    for (const test of run.tests) {
      const key = `${test.targetId}\u0000${test.agent}\u0000${test.testId}`;
      const list = samples.get(key) ?? [];
      list.push({ run, test });
      samples.set(key, list);
    }
  }

  const tests = [...samples.values()]
    .map((list) => scoreTest(list, minRuns, brokenAfter))
    .toSorted(
      (a, b) =>
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
        b.flakeRate - a.flakeRate ||
        b.failures - a.failures ||
        a.testId.localeCompare(b.testId) ||
        a.targetId.localeCompare(b.targetId) ||
        a.agent.localeCompare(b.agent),
    );

  const counts: Record<Verdict, number> = { broken: 0, failing: 0, flaky: 0, new: 0, stable: 0 };
  for (const test of tests) counts[test.verdict] += 1;

  const cache = emptyCache();
  let costUsd: number | undefined;
  let modelTokens = 0;
  for (const run of runs) {
    modelTokens += run.modelTokens;
    if (run.costUsd !== undefined) costUsd = (costUsd ?? 0) + run.costUsd;
    for (const test of run.tests) addCache(cache, test.cache);
  }

  const first = runs[0];
  const last = runs.at(-1);
  return {
    runs: runs.length,
    ...(first ? { from: first.startedAt } : {}),
    ...(last ? { to: last.startedAt } : {}),
    window,
    minRuns,
    passedRuns: runs.filter((run) => run.status === 'passed').length,
    ...(costUsd === undefined ? {} : { costUsd }),
    modelTokens,
    cache,
    tests,
    counts,
  };
}

/**
 * The tests an analysis would quarantine: `flaky` ones whose rate exceeds
 * `maxFlakeRate`. A `failing` or `broken` test is never among them, so a
 * failure the latest run saw stays visible whatever the test's past.
 */
export function quarantined(insights: Insights, maxFlakeRate: number): TestInsight[] {
  return insights.tests.filter((test) => test.verdict === 'flaky' && test.flakeRate > maxFlakeRate);
}

interface Sample {
  run: HistoryRun;
  test: HistoryTest;
}

/** What one result says, with a retry pass after infrastructure-only failures read as a plain pass. */
function outcomeOf(test: HistoryTest): Outcome {
  const failed = test.status === 'failed' || test.status === 'timed-out';
  if (failed) return test.errorCategory !== undefined && INFRA_CATEGORIES.has(test.errorCategory) ? 'infra' : 'fail';
  if (test.status !== 'flaky') return 'pass';
  const failedAttempts = test.attemptErrors.filter((_, index) => test.attempts[index] !== 'passed');
  const infraOnly = failedAttempts.length > 0 && failedAttempts.every((category) => category !== null && INFRA_CATEGORIES.has(category));
  return infraOnly ? 'pass' : 'retry';
}

function scoreTest(list: readonly Sample[], minRuns: number, brokenAfter: number): TestInsight {
  const latest = list.at(-1)!.test;
  const outcomes = list.map(({ test }) => outcomeOf(test));

  let modelCalls = 0;
  let tokens = 0;
  let costUsd: number | undefined;
  const cache = emptyCache();
  const errorCodes = new Map<string, number>();
  const durations: number[] = [];
  for (const [index, { test }] of list.entries()) {
    durations.push(test.durationMs);
    modelCalls += test.modelCalls;
    tokens += test.tokens;
    if (test.costUsd !== undefined) costUsd = (costUsd ?? 0) + test.costUsd;
    addCache(cache, test.cache);
    if (outcomes[index] !== 'pass' && outcomes[index] !== 'retry' && test.errorCode) {
      errorCodes.set(test.errorCode, (errorCodes.get(test.errorCode) ?? 0) + 1);
    }
  }

  const passes = outcomes.filter((outcome) => outcome === 'pass').length;
  const retryPasses = outcomes.filter((outcome) => outcome === 'retry').length;
  const failures = outcomes.filter((outcome) => outcome === 'fail').length;
  const infraFailures = outcomes.filter((outcome) => outcome === 'infra').length;

  const { flaky: sameCommitFailures, flips: sameCommitFlips } = sameCommitEvidence(list, outcomes);
  const flakyFailures = new Set([...boundedFailures(outcomes, brokenAfter), ...sameCommitFailures]);
  const flakeEvents = retryPasses + flakyFailures.size;
  const counted = list.length - infraFailures;
  const flakeRate = counted > 0 ? flakeEvents / counted : 0;

  let failStreak = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index];
    if (outcome === 'infra') continue;
    if (outcome !== 'fail') break;
    failStreak += 1;
  }

  let verdict: Verdict;
  if (list.length < minRuns) verdict = 'new';
  else if (failStreak >= brokenAfter) verdict = 'broken';
  else if (failStreak > 0) verdict = 'failing';
  else if (flakeEvents > 0) verdict = 'flaky';
  else verdict = 'stable';

  const topErrorCode = [...errorCodes.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const sorted = durations.toSorted((a, b) => a - b);

  return {
    testId: latest.testId,
    targetId: latest.targetId,
    agent: latest.agent,
    titlePath: latest.titlePath,
    file: latest.file,
    verdict,
    runs: list.length,
    passes,
    retryPasses,
    failures,
    infraFailures,
    flakeEvents,
    flakeRate,
    sameCommitFlips,
    failStreak,
    timeline: outcomes,
    ...(topErrorCode === undefined ? {} : { topErrorCode }),
    lastStatus: latest.status,
    lastSeen: list.at(-1)!.run.startedAt,
    medianDurationMs: percentile(sorted, 0.5),
    p95DurationMs: percentile(sorted, 0.95),
    modelCalls,
    tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    cache,
  };
}

/**
 * Indexes of failures in a run of fewer than `brokenAfter` failures with a
 * pass on both sides. A run that touches either end of the window is left
 * out: a leading one may be a regression that was fixed, a trailing one a
 * regression that is still there. Infrastructure failures neither count nor
 * break a run.
 */
function boundedFailures(outcomes: readonly Outcome[], brokenAfter: number): number[] {
  const flaky: number[] = [];
  let sawPass = false;
  let pending: number[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === 'infra') continue;
    if (outcome === 'fail') {
      pending.push(index);
      continue;
    }
    if (sawPass && pending.length > 0 && pending.length < brokenAfter) flaky.push(...pending);
    pending = [];
    sawPass = true;
  }
  return flaky;
}

/**
 * Failures on a clean commit the test also passed on, and how many such
 * commits there are. A dirty checkout is left out: its commit does not name
 * the code that ran.
 */
function sameCommitEvidence(list: readonly Sample[], outcomes: readonly Outcome[]): { flaky: number[]; flips: number } {
  const byCommit = new Map<string, { passed: boolean; failures: number[]; retried: boolean }>();
  for (const [index, { run }] of list.entries()) {
    const commit = run.vcs && run.vcs.dirty !== true ? run.vcs.commit : undefined;
    const outcome = outcomes[index];
    if (commit === undefined || outcome === 'infra') continue;
    const seen = byCommit.get(commit) ?? { passed: false, failures: [], retried: false };
    if (outcome === 'fail') seen.failures.push(index);
    else seen.passed = true;
    if (outcome === 'retry') seen.retried = true;
    byCommit.set(commit, seen);
  }
  const flaky: number[] = [];
  let flips = 0;
  for (const seen of byCommit.values()) {
    if (seen.passed && seen.failures.length > 0) flaky.push(...seen.failures);
    if ((seen.passed && seen.failures.length > 0) || seen.retried) flips += 1;
  }
  return { flaky, flips };
}

/** Nearest-rank percentile of a sorted list; 0 for an empty one. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank]!;
}

function emptyCache(): CacheCounts {
  return { steps: 0, replayed: 0, handedOff: 0, missed: 0, reasons: {} };
}

function addCache(into: CacheCounts, from: CacheCounts): void {
  into.steps += from.steps;
  into.replayed += from.replayed;
  into.handedOff += from.handedOff;
  into.missed += from.missed;
  for (const [reason, count] of Object.entries(from.reasons)) into.reasons[reason] = (into.reasons[reason] ?? 0) + count;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`expected a positive integer, got ${value}`);
  return value;
}
