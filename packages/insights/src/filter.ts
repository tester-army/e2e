import path from 'node:path';
import type { TestFilter, TestFilterResult } from 'e2e';
import { analyze, quarantined, type AnalyzeOptions } from './analyze.ts';
import { DEFAULT_HISTORY_DIR } from './reporter.ts';
import { HISTORY_FILE, loadHistory } from './store.ts';

export interface QuarantineOptions extends AnalyzeOptions {
  /** History files, relative to the project root; default `.e2e/history/runs.jsonl`. Several are merged. */
  history?: string | readonly string[];
  /** Flake rate a test must exceed to be quarantined, 0 through 1; default 0.1. */
  maxFlakeRate?: number;
  /**
   * `skip` leaves quarantined tests out of the run; `report` (the default)
   * runs everything and only names them in the filter's note, so you can
   * watch what it would do before it does it.
   */
  mode?: 'report' | 'skip';
}

/**
 * A test filter that quarantines flaky tests by their history:
 *
 * ```ts
 * import { insights, quarantineFilter } from '@e2e-dev/insights';
 * export default {
 *   targets,
 *   reporters: ['list', insights()],
 *   filters: [quarantineFilter({ mode: 'skip' })],
 * } satisfies E2EConfig;
 * ```
 *
 * A test is quarantined when its verdict is `flaky` and its flake rate is
 * above `maxFlakeRate` on any target or agent. A test whose latest result
 * failed is `failing` or `broken`, never `flaky`, so it always runs: a
 * regression the pull request itself caused stays red however the test
 * behaved before. Reads the history only when
 * the run calls it, and an empty or missing history leaves everything in.
 */
export function quarantineFilter(options: QuarantineOptions = {}): TestFilter {
  const maxFlakeRate = options.maxFlakeRate ?? 0.1;
  const mode = options.mode ?? 'report';
  if (typeof maxFlakeRate !== 'number' || !(maxFlakeRate >= 0 && maxFlakeRate <= 1)) {
    throw new TypeError(`quarantineFilter({ maxFlakeRate }) must be between 0 and 1, got ${String(maxFlakeRate)}`);
  }
  if (mode !== 'report' && mode !== 'skip') throw new TypeError(`quarantineFilter({ mode }) must be 'report' or 'skip'`);
  const files =
    options.history === undefined
      ? [path.join(DEFAULT_HISTORY_DIR, HISTORY_FILE)]
      : typeof options.history === 'string'
        ? [options.history]
        : [...options.history];
  const analyzeOptions: AnalyzeOptions = {
    ...(options.window === undefined ? {} : { window: options.window }),
    ...(options.minRuns === undefined ? {} : { minRuns: options.minRuns }),
    ...(options.brokenAfter === undefined ? {} : { brokenAfter: options.brokenAfter }),
  };

  return {
    name: 'quarantine',
    async filter(tests, context): Promise<TestFilterResult> {
      const { runs } = await loadHistory(files.map((file) => path.resolve(context.projectRoot, file)));
      const result = analyze(runs, analyzeOptions);
      const candidates = new Set(tests.map((test) => test.id));
      const reasons = new Map<string, string>();
      for (const test of quarantined(result, maxFlakeRate)) {
        if (!candidates.has(test.testId) || reasons.has(test.testId)) continue;
        const counted = test.runs - test.infraFailures;
        reasons.set(
          test.testId,
          `flaky in ${test.flakeEvents} of ${counted} runs (${Math.round(test.flakeRate * 100)}%) on ${test.agent === 'default' ? test.targetId : `${test.targetId} as ${test.agent}`}`,
        );
      }
      if (mode === 'report') {
        return reasons.size === 0
          ? { exclude: {} }
          : { exclude: {}, note: `would quarantine ${reasons.size} flaky ${reasons.size === 1 ? 'test' : 'tests'}; set mode: 'skip' to leave them out` };
      }
      return {
        exclude: Object.fromEntries(reasons),
        ...(reasons.size === 0 ? {} : { note: `quarantined ${reasons.size} flaky ${reasons.size === 1 ? 'test' : 'tests'} from ${result.runs} runs` }),
      };
    },
  };
}
