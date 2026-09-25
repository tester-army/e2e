/** A rerun folded into the run before it: what the page shows for each kind of test. */

import { describe, expect, it } from 'vitest';
import { foldLastRun } from '../../src/merge.ts';
import { attempt, report, result } from './fixtures.ts';

const failedAttempt = attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'no cart' } });
const skippedAsPassedBefore = { cause: 'filtered' as const, reason: 'did not fail in the last run' };

const firstPass = report({
  status: 'failed',
  results: [
    result({ title: 'steady', status: 'passed', attempts: [attempt({ durationMs: 500 })] }),
    result({ title: 'recovers', status: 'failed', attempts: [failedAttempt, failedAttempt] }),
    result({ title: 'still broken', status: 'failed', attempts: [failedAttempt] }),
    result({ title: 'never wanted', status: 'skipped', skip: { cause: 'explicit', reason: 'later' } }),
  ],
});

const rerun = report({
  status: 'failed',
  results: [
    result({ title: 'steady', status: 'skipped', selected: false, skip: skippedAsPassedBefore }),
    result({ title: 'recovers', status: 'passed', attempts: [attempt({ durationMs: 900 })] }),
    result({ title: 'still broken', status: 'failed', attempts: [failedAttempt] }),
    result({ title: 'never wanted', status: 'skipped', selected: false, skip: skippedAsPassedBefore }),
    result({ title: 'new since', status: 'passed', attempts: [attempt()] }),
  ],
});

describe('foldLastRun', () => {
  it('carries the tests the rerun left out, marks a recovered test flaky with both runs\' attempts, and keeps a still-failing one failed', () => {
    const folded = foldLastRun(rerun, firstPass);
    const byTitle = new Map(folded.run.results.map((entry) => [entry.titlePath[0], entry]));
    expect(byTitle.get('steady')).toMatchObject({ status: 'passed', selected: true });
    expect(byTitle.get('steady')?.attempts).toHaveLength(1);
    expect(byTitle.get('recovers')).toMatchObject({ status: 'flaky', selected: true });
    expect(byTitle.get('recovers')?.attempts.map((entry) => entry.status)).toEqual(['failed', 'failed', 'passed']);
    expect(byTitle.get('still broken')).toMatchObject({ status: 'failed' });
    expect(byTitle.get('still broken')?.attempts).toHaveLength(2);
    // An explicit skip stays what the run before said it was; a test the run before never had is the rerun's.
    expect(byTitle.get('never wanted')).toMatchObject({ status: 'skipped', skip: { cause: 'explicit' } });
    expect(byTitle.get('new since')).toMatchObject({ status: 'passed', selected: true });
    expect(folded.run.summary).toMatchObject({ discovered: 5, selected: 5, executed: 4, passed: 2, flaky: 1, failed: 1, skipped: 1 });
    // The rerun decides the outcome; the start is the run before's, so the duration spans both.
    expect(folded.run.status).toBe('failed');
    expect(folded.run.startedAt).toBe(firstPass.run.startedAt);
    expect(folded.run.finishedAt).toBe(rerun.run.finishedAt);
  });

  it('leaves the rerun alone when the run before is another project\'s', () => {
    const other = report({ ...firstPass, projectId: 'dev.example.other' });
    expect(foldLastRun(rerun, { ...other, run: { ...other.run, results: firstPass.run.results } })).toBe(rerun);
  });

  it('keeps the serial groups of both runs, the rerun\'s winning on a shared id', () => {
    const before = report({ serialGroups: [{ id: 'g1', members: [] } as never, { id: 'g2', members: [] } as never] });
    const now = report({ serialGroups: [{ id: 'g2', members: [{ id: 'm' }] } as never] });
    expect(foldLastRun(now, before).run.serialGroups.map((group) => group.id)).toEqual(['g1', 'g2']);
    expect(foldLastRun(now, before).run.serialGroups[1]).toEqual(now.run.serialGroups[0]);
  });
});
