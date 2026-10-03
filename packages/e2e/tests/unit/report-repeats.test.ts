/** The `--repeat-each` tally: grouping, the summary, and the line for a test that did not pass every run. */

import { describe, expect, it } from 'vitest';
import { repeatGroups, repeatLine, repeatSummary, type RepeatRun } from '../../src/report/repeats.ts';

const run = (key: string, repeat: number, status: string, code?: string) => ({ key, label: key, run: { repeat, status, code } satisfies RepeatRun });

describe('repeat tally', () => {
  it('groups the runs of each test in repeat order and leaves out a test that ran once or skipped every run', () => {
    const groups = repeatGroups(
      [
        run('pays', 1, 'failed', 'ASSERTION_FAILED'),
        run('pays', 0, 'passed'),
        run('pays', 2, 'flaky', 'STEP_TIMEOUT'),
        run('once', 0, 'failed', 'ACTION_FAILED'),
        run('skipped', 0, 'skipped'),
        run('skipped', 1, 'skipped'),
        run('stable', 0, 'passed'),
        run('stable', 1, 'passed'),
        run('stable', 2, 'passed'),
      ],
      (entry) => entry,
    );
    expect(groups.map((group) => [group.label, group.passed, group.unstable, group.runs.map((entry) => entry.repeat)])).toEqual([
      ['pays', 1, true, [0, 1, 2]],
      ['stable', 3, false, [0, 1, 2]],
    ]);
    expect(repeatSummary(groups)).toBe('1 of 2 tests passed all 3 runs');
    expect(repeatLine(groups[0]!)).toBe('1/3 passed · repeat 1 ASSERTION_FAILED · repeat 2 flaky (STEP_TIMEOUT)');
  });

  it('counts a run the run interrupted or never started as a miss, not a flake', () => {
    const groups = repeatGroups(
      [run('cut', 0, 'passed'), run('cut', 1, 'interrupted', 'INTERRUPTED'), run('cut', 2, 'skipped'), run('flake', 0, 'passed'), run('flake', 1, 'failed', 'ASSERTION_FAILED')],
      (entry) => entry,
    );
    expect(groups.map((group) => [group.label, group.passed, group.unstable])).toEqual([
      ['cut', 1, false],
      ['flake', 1, true],
    ]);
    expect(repeatLine(groups[0]!)).toBe('1/3 passed · repeat 1 interrupted · repeat 2 skipped');
  });
});
