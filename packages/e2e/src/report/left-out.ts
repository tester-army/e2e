/**
 * How many tests a run's test filters left out, counted one way by every
 * reporter and by telemetry: in tests, as `run.filters[].excluded` and each
 * filter's line count them, so a test left out on several targets, agents,
 * or repeats counts once.
 */

import type { SkipInfo } from '../collect/select.ts';

/** How many tests each test filter left out of `results`, by its name in the order first seen. */
export function leftOutTests(results: Iterable<{ readonly testId: string; readonly skip?: SkipInfo | undefined }>): Map<string, number> {
  const tests = new Map<string, Set<string>>();
  for (const result of results) {
    const filter = result.skip?.filter;
    if (filter !== undefined) tests.set(filter, (tests.get(filter) ?? new Set<string>()).add(result.testId));
  }
  return new Map([...tests].map(([filter, ids]) => [filter, ids.size]));
}
