/** A rerun folded into the run before it: what the page shows for each kind of test. */

import { renderMarkdownReport, type Report } from 'e2e';
import { describe, expect, it } from 'vitest';
import { foldLastRun } from '../../src/merge.ts';
import { attempt, report, result } from './fixtures.ts';

type ReportSerialGroup = Report['run']['serialGroups'][number];
type ReportSerialAttempt = ReportSerialGroup['attempts'][number];

const failedAttempt = attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'no cart' } });
const leftOut = { cause: 'filtered' as const, reason: 'did not fail in the last run' };

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
    result({ title: 'steady', status: 'skipped', selected: false, skip: leftOut }),
    result({ title: 'recovers', status: 'passed', attempts: [attempt({ durationMs: 900 })] }),
    result({ title: 'still broken', status: 'failed', attempts: [failedAttempt] }),
    result({ title: 'never wanted', status: 'skipped', selected: false, skip: leftOut }),
    result({ title: 'new since', status: 'passed', attempts: [attempt()] }),
  ],
});

const byTitle = (document: Report) => new Map(document.run.results.map((entry) => [`${entry.titlePath[0]}#${entry.repeat}`, entry]));

/** A serial group of one member, with one attempt in the given state. */
function serialGroup(id: string, memberTestId: string, status: 'passed' | 'failed'): ReportSerialGroup {
  const serialAttempt: ReportSerialAttempt = {
    id: `${id}:attempt`,
    index: 0,
    status,
    startedAt: '2026-07-24T12:00:00.000Z',
    durationMs: 700,
    artifacts: [],
    secondaryErrors: [],
    cleanup: 'complete',
    ...(status === 'failed' ? { error: { category: 'test', code: 'ASSERTION_FAILED', message: 'step one broke', retryable: false } } : {}),
    members: [
      {
        id: `${id}:member`,
        index: 0,
        testId: memberTestId,
        status,
        startedAt: '2026-07-24T12:00:00.000Z',
        durationMs: 700,
        steps: [],
        secondaryErrors: [],
        ...(status === 'failed' ? { error: { category: 'test', code: 'ASSERTION_FAILED', message: 'step one broke', retryable: false } } : {}),
      },
    ],
  };
  return {
    id,
    serialId: 'wizard',
    declarationIndex: 0,
    file: 'tests/example.e2e.ts',
    source: { file: 'tests/example.e2e.ts', line: 1, column: 1 },
    titlePath: ['wizard'],
    targetId: 'web',
    platform: 'web',
    agent: 'default',
    repeat: 0,
    memberTestIds: [memberTestId],
    status,
    attempts: [serialAttempt],
  };
}

describe('foldLastRun', () => {
  it('carries the tests the rerun left out, marks a recovered test flaky with both runs\' attempts, and keeps a still-failing one failed', () => {
    const folded = foldLastRun(rerun, firstPass);
    const entries = byTitle(folded);
    expect(entries.get('steady#0')).toMatchObject({ status: 'passed', selected: true });
    expect(entries.get('steady#0')?.attempts).toHaveLength(1);
    expect(entries.get('recovers#0')).toMatchObject({ status: 'flaky', selected: true });
    expect(entries.get('recovers#0')?.attempts.map((entry) => entry.status)).toEqual(['failed', 'failed', 'passed']);
    expect(entries.get('still broken#0')).toMatchObject({ status: 'failed' });
    expect(entries.get('still broken#0')?.attempts).toHaveLength(2);
    // An explicit skip stays what the run before said it was; a test the run before never had is the rerun's.
    expect(entries.get('never wanted#0')).toMatchObject({ status: 'skipped', skip: { cause: 'explicit' } });
    expect(entries.get('new since#0')).toMatchObject({ status: 'passed', selected: true });
    expect(folded.run.summary).toMatchObject({ discovered: 5, selected: 5, executed: 4, passed: 2, flaky: 1, failed: 1, skipped: 1 });
    // The rerun decides the outcome; the start is the run before's, so the duration spans both.
    expect(folded.run.status).toBe('failed');
    expect(folded.run.startedAt).toBe(firstPass.run.startedAt);
    expect(folded.run.finishedAt).toBe(rerun.run.finishedAt);
  });

  it('folds the repeats a plain rerun ran once into its one result, and carries the repeats of a test it left out', () => {
    const before = report({
      status: 'failed',
      results: [
        result({ title: 'wobbly', status: 'passed', repeat: 0, attempts: [attempt()] }),
        result({ title: 'wobbly', status: 'failed', repeat: 1, attempts: [failedAttempt] }),
        result({ title: 'wobbly', status: 'failed', repeat: 2, attempts: [failedAttempt] }),
        result({ title: 'solid', status: 'passed', repeat: 0, attempts: [attempt()] }),
        result({ title: 'solid', status: 'passed', repeat: 1, attempts: [attempt()] }),
      ],
    });
    const once = report({
      results: [
        result({ title: 'wobbly', status: 'passed', attempts: [attempt()] }),
        result({ title: 'solid', status: 'skipped', selected: false, skip: leftOut }),
      ],
    });
    const folded = foldLastRun(once, before);
    const entries = byTitle(folded);
    expect(folded.run.results).toHaveLength(3);
    expect(entries.get('wobbly#0')).toMatchObject({ status: 'flaky' });
    expect(entries.get('wobbly#0')?.attempts.map((entry) => entry.status)).toEqual(['passed', 'failed', 'failed', 'passed']);
    expect(entries.get('wobbly#1')).toBeUndefined();
    expect(entries.get('solid#0')).toMatchObject({ status: 'passed', selected: true });
    expect(entries.get('solid#1')).toMatchObject({ status: 'passed', selected: true });
    expect(folded.run.summary).toMatchObject({ discovered: 3, passed: 2, flaky: 1, failed: 0 });
    expect(folded.run.status).toBe('passed');
  });

  it('joins a rerun serial group\'s attempts to the run before\'s, so a member that passed after failing shows its failure', () => {
    const memberTestId = 'tests/example.e2e.ts::wizard::step%20one';
    const member = (status: 'passed' | 'failed', selected = true) =>
      result({ title: ['wizard', 'step one'], status, serialGroupId: 'g1', ...(selected ? {} : { selected: false, skip: leftOut }) });
    const before = report({ status: 'failed', results: [member('failed')], serialGroups: [serialGroup('g1', memberTestId, 'failed')] });
    const after = report({ results: [member('passed')], serialGroups: [serialGroup('g1', memberTestId, 'passed')] });
    const folded = foldLastRun(after, before);
    expect(folded.run.serialGroups).toHaveLength(1);
    expect(folded.run.serialGroups[0]?.attempts.map((entry) => [entry.index, entry.status])).toEqual([
      [0, 'failed'],
      [1, 'passed'],
    ]);
    expect(folded.run.results[0]).toMatchObject({ status: 'flaky' });
    const page = renderMarkdownReport(folded);
    expect(page).toContain('1 flaky test passed on a retry');
    expect(page).toContain('step one broke');
    // A group of a repeat the rerun never had stays beside the rerun's.
    const twoGroups = foldLastRun(after, { ...before, run: { ...before.run, serialGroups: [...before.run.serialGroups, serialGroup('g2', memberTestId, 'passed')] } });
    expect(twoGroups.run.serialGroups.map((group) => group.id)).toEqual(['g2', 'g1']);
  });

  it('turns the page red when a filter kept a failed test out of the rerun, since the page lists that failure', () => {
    const before = report({
      status: 'failed',
      results: [
        result({ title: 'A', status: 'failed', attempts: [failedAttempt] }),
        result({ title: 'B', status: 'failed', attempts: [failedAttempt] }),
      ],
    });
    const onlyB = report({
      results: [
        result({ title: 'A', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
        result({ title: 'B', status: 'passed', attempts: [attempt()] }),
      ],
    });
    const folded = foldLastRun(onlyB, before);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'failed', selected: true });
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'flaky' });
    expect(folded.run.status).toBe('failed');
    expect(folded.run.exitCode).toBe(1);
    expect(renderMarkdownReport(folded)).toContain('### 🔴 e2e: 1 failed, 1 flaky');
  });

  it('leaves the rerun alone when the run before is another project\'s', () => {
    const other = report({ projectId: 'dev.example.other', status: 'failed', results: firstPass.run.results });
    expect(foldLastRun(rerun, other)).toBe(rerun);
  });
});
