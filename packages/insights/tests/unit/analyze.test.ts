import { describe, expect, it } from 'vitest';
import { digestReport } from '../../src/digest.ts';
import { analyze, quarantined } from '../../src/analyze.ts';
import { history, makeReport, pattern } from './helpers.ts';

const score = (statuses: string, options = {}) => analyze(history(pattern('t', statuses)), options).tests[0]!;
const isQuarantined = (statuses: string) => quarantined(analyze(history(pattern('t', statuses))), 0.1).length > 0;

describe('analyze', () => {
  it('calls a test that always passed stable', () => {
    expect(score('pppppppppp')).toMatchObject({ verdict: 'stable', flakeRate: 0, flakeEvents: 0 });
  });

  it('catches the 1-in-10 failure a single run never shows', () => {
    expect(score('ppppfppppp')).toMatchObject({ verdict: 'flaky', failures: 1, flakeEvents: 1, flakeRate: 0.1 });
  });

  it('counts a pass on a retry as a flake', () => {
    expect(score('pppprppppp')).toMatchObject({ verdict: 'flaky', retryPasses: 1, flakeEvents: 1 });
  });

  it('does not count a retry that passed after an infrastructure failure', () => {
    expect(score('ppppxppppp')).toMatchObject({ verdict: 'stable', retryPasses: 0, passes: 10 });
  });

  it('calls a test broken after brokenAfter failures in a row', () => {
    expect(score('pppppppfff')).toMatchObject({ verdict: 'broken', failStreak: 3 });
  });

  it('calls a fresh regression failing, not flaky, and never quarantines it', () => {
    expect(score('ppppppppff')).toMatchObject({ verdict: 'failing', failStreak: 2, flakeEvents: 0 });
    expect(isQuarantined('ppppppppff')).toBe(false);
    expect(isQuarantined('pfppfppppf')).toBe(false);
  });

  it('calls a fixed regression stable, not flaky', () => {
    expect(score('fffffffffp')).toMatchObject({ verdict: 'stable', flakeEvents: 0 });
    expect(score('ppfffffppp')).toMatchObject({ verdict: 'stable', flakeEvents: 0 });
    expect(isQuarantined('fffffffffp')).toBe(false);
  });

  it('leaves infrastructure failures out of the flake rate and the fail streak', () => {
    expect(score('ppppippppp')).toMatchObject({ verdict: 'stable', infraFailures: 1, flakeRate: 0 });
    expect(score('pppppffiff')).toMatchObject({ verdict: 'broken', failStreak: 4 });
  });

  it('calls a test with fewer than minRuns results new', () => {
    expect(score('pfp')).toMatchObject({ verdict: 'new' });
    expect(score('pfp', { minRuns: 3 })).toMatchObject({ verdict: 'flaky' });
  });

  it('looks only at the newest window runs', () => {
    expect(score('pfpppppppp', { window: 9 })).toMatchObject({ verdict: 'stable', runs: 9 });
  });

  it('counts a failure on a clean commit the test also passed on, wherever it falls', () => {
    const runs = history(pattern('t', 'fppppppp'), (index) => (index < 2 ? 'aaaa' : `b${index}`));
    expect(analyze(runs).tests[0]).toMatchObject({ verdict: 'flaky', sameCommitFlips: 1, flakeEvents: 1 });
  });

  it('ignores commits of a dirty checkout', () => {
    const runs = pattern('t', 'fppppppp').map((results, index) =>
      digestReport(makeReport(results, { commit: index < 2 ? 'aaaa' : `b${index}`, dirty: index < 2 })),
    );
    expect(analyze(runs).tests[0]).toMatchObject({ verdict: 'stable', sameCommitFlips: 0 });
  });

  it('keeps one timeline per target', () => {
    const runs = history([
      [{ testId: 't', status: 'passed', targetId: 'chromium' }, { testId: 't', status: 'passed', targetId: 'webkit' }],
      [{ testId: 't', status: 'passed', targetId: 'chromium' }, { testId: 't', status: 'failed', targetId: 'webkit' }],
      [{ testId: 't', status: 'passed', targetId: 'chromium' }, { testId: 't', status: 'passed', targetId: 'webkit' }],
    ]);
    const result = analyze(runs, { minRuns: 1 });
    expect(result.tests.map((test) => [test.targetId, test.verdict, test.timeline])).toEqual([
      ['webkit', 'flaky', ['pass', 'fail', 'pass']],
      ['chromium', 'stable', ['pass', 'pass', 'pass']],
    ]);
  });

  it('keeps one timeline per agent, so a test that always fails under one agent is broken, not flaky', () => {
    const runs = history(
      [...'pppppp'].map(() => [
        { testId: 't', status: 'passed' as const, agent: 'a' },
        { testId: 't', status: 'failed' as const, agent: 'b' },
      ]),
    );
    expect(analyze(runs).tests.map((test) => [test.agent, test.verdict])).toEqual([
      ['b', 'broken'],
      ['a', 'stable'],
    ]);
  });

  it('sorts broken, failing, flaky by rate, new, then stable', () => {
    const runs = history(
      [...'pppppppppp'].map((_, index) => [
        { testId: 'stable', status: 'passed' as const },
        { testId: 'rare', status: index === 4 ? ('failed' as const) : ('passed' as const) },
        { testId: 'often', status: index % 2 === 0 ? ('failed' as const) : ('passed' as const) },
        { testId: 'failing', status: index === 9 ? ('failed' as const) : ('passed' as const) },
        { testId: 'broken', status: index < 5 ? ('passed' as const) : ('failed' as const) },
      ]),
    );
    expect(analyze(runs).tests.map((test) => test.testId)).toEqual(['broken', 'failing', 'often', 'rare', 'stable']);
  });

  it('adds up cache and cost per test and per window', () => {
    const runs = history([
      [{ testId: 't', status: 'passed', cache: ['missed', 'self-finalized'], costUsd: 0.01 }],
      [{ testId: 't', status: 'passed', cache: ['self-finalized', 'self-finalized'], costUsd: 0.02 }],
    ]);
    const result = analyze(runs);
    expect(result.cache).toMatchObject({ steps: 4, replayed: 3, missed: 1 });
    expect(result.tests[0]!.cache.reasons).toEqual({ 'no-entry': 1 });
    expect(result.tests[0]!.costUsd).toBeCloseTo(0.06, 5);
  });

  it('rejects a window that is not a positive integer', () => {
    expect(() => analyze([], { window: 0 })).toThrow(RangeError);
  });
});

describe('quarantined', () => {
  it('names flaky tests above the rate and never broken or failing ones', () => {
    const runs = history(
      [...'pppppppppp'].map((_, index) => [
        { testId: 'rare', status: index === 4 ? ('failed' as const) : ('passed' as const) },
        { testId: 'often', status: index % 2 === 0 ? ('failed' as const) : ('passed' as const) },
        { testId: 'failing', status: index % 2 === 1 ? ('failed' as const) : ('passed' as const) },
        { testId: 'broken', status: index < 5 ? ('passed' as const) : ('failed' as const) },
      ]),
    );
    expect(quarantined(analyze(runs), 0.1).map((test) => test.testId)).toEqual(['often']);
  });
});
