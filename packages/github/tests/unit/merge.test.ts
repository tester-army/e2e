/** A rerun folded into the run before it: what the page shows for each kind of test. */

import { renderMarkdownReport, type Report } from 'e2e';
import { describe, expect, it } from 'vitest';
import { foldLastRun } from '../../src/merge.ts';
import { attempt, report, result } from './fixtures.ts';

type ReportSerialGroup = Report['run']['serialGroups'][number];
type ReportSerialAttempt = ReportSerialGroup['attempts'][number];
type ReportError = Report['run']['errors'][number];

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
    expect(folded.run.summary).toMatchObject({ discovered: 5, selected: 5, executed: 4, passed: 2, flaky: 1, failed: 1, interrupted: 0, skipped: 1 });
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

  it('counts an interrupted test apart from failures: one that passes on the rerun is not flaky, and a carried one keeps the page from reading green', () => {
    const interruptedAttempt = attempt({ status: 'interrupted', error: { category: 'interrupted', code: 'INTERRUPTED', message: 'run interrupted in phase test' } });
    const before = report({
      status: 'interrupted',
      results: [
        result({ title: 'A', status: 'interrupted', attempts: [interruptedAttempt] }),
        result({ title: 'B', status: 'interrupted', attempts: [interruptedAttempt] }),
      ],
    });
    const onlyA = report({
      results: [
        result({ title: 'A', status: 'passed', attempts: [attempt()] }),
        result({ title: 'B', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
      ],
    });
    const folded = foldLastRun(onlyA, before);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'passed' });
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'interrupted', selected: true });
    expect(folded.run.summary).toMatchObject({ selected: 2, passed: 1, failed: 0, interrupted: 1, flaky: 0, skipped: 0 });
    expect(folded.run.status).toBe('passed');
    expect(renderMarkdownReport(folded)).toContain('### ⏹️ e2e: 1 interrupted, 1 passed');
  });

  it('keeps the first pass\'s failure when the rerun of that test is interrupted', () => {
    const interruptedAttempt = attempt({ status: 'interrupted', error: { category: 'interrupted', code: 'INTERRUPTED', message: 'run interrupted in phase test' } });
    const before = report({ status: 'failed', results: [result({ title: 'A', status: 'failed', attempts: [failedAttempt] })] });
    const cut = report({ status: 'interrupted', results: [result({ title: 'A', status: 'interrupted', attempts: [interruptedAttempt] })] });
    const folded = foldLastRun(cut, before);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'failed' });
    expect(folded.run.summary).toMatchObject({ failed: 1, interrupted: 0 });
    expect(renderMarkdownReport(folded)).toContain('### 🔴 e2e: 1 failed');
  });

  it('keeps the page red while the rerun carries a hook failure or a failed test it did not run again, with their evidence', () => {
    const scope = { file: 'tests/a.e2e.ts', targetId: 'web', titlePath: [] };
    const hook: ReportError = { category: 'test', code: 'HOOK_FAILED', message: 'afterAll failed: teardown broke', retryable: false, phase: 'afterAll', scopeId: 'file', scope };
    const evidence = attempt({ artifacts: ['screenshot'] });
    const inHookScope = result({ title: 'A', file: 'tests/a.e2e.ts', status: 'passed', attempts: [evidence] });
    const before = report({ status: 'failed', results: [inHookScope, result({ title: 'B', status: 'failed', attempts: [failedAttempt] })], errors: [hook] });
    const onlyB = report({
      results: [
        result({ title: 'A', file: 'tests/a.e2e.ts', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
        result({ title: 'B', status: 'passed', attempts: [attempt()] }),
      ],
      carried: { results: [inHookScope], serialGroups: [], errors: [hook] },
    });
    const folded = foldLastRun(onlyB, before);
    expect(byTitle(folded).get('A#0')).toEqual(inHookScope);
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'flaky' });
    expect(folded.run.errors).toEqual([hook]);
    expect(folded.run.status).toBe('failed');
    expect(folded.run.exitCode).toBe(1);
    const page = renderMarkdownReport(folded);
    expect(page).toContain('### 🔴 e2e: 1 flaky, 1 passed');
    expect(page).toContain('HOOK_FAILED');

    // A carried test that failed reds the page on its own.
    const carriedFailure = result({ title: 'C', status: 'failed', attempts: [failedAttempt] });
    const withFailure = report({
      results: [result({ title: 'C', status: 'skipped', selected: false, skip: leftOut }), result({ title: 'B', status: 'passed', attempts: [attempt()] })],
      carried: { results: [carriedFailure], serialGroups: [], errors: [] },
    });
    expect(foldLastRun(withFailure, report({ results: [result({ title: 'B', status: 'skipped', selected: false, skip: leftOut })] })).run.status).toBe('failed');

    // So does one the failure limit stopped before it ever ran.
    const neverRan = result({ title: 'D', status: 'skipped', skip: { cause: 'failure-limit', reason: 'run stopped after 1 failure (--max-failures 1)' } });
    const withLimit = report({
      results: [result({ title: 'D', status: 'skipped', selected: false, skip: leftOut }), result({ title: 'B', status: 'passed', attempts: [attempt()] })],
      carried: { results: [neverRan], serialGroups: [], errors: [] },
    });
    expect(foldLastRun(withLimit, report({ results: [result({ title: 'B', status: 'skipped', selected: false, skip: leftOut })] })).run).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('reads a test the run before carried by the row it carried, so a rerun that runs it at last folds in its first failure', () => {
    const firstFailure = result({ title: 'A', status: 'failed', attempts: [failedAttempt] });
    const narrowed = report({
      results: [
        result({ title: 'A', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
        result({ title: 'B', status: 'passed', attempts: [attempt()] }),
      ],
      carried: { results: [firstFailure], serialGroups: [], errors: [] },
    });
    const atLast = report({
      results: [result({ title: 'A', status: 'passed', attempts: [attempt()] }), result({ title: 'B', status: 'skipped', selected: false, skip: leftOut })],
    });
    const folded = foldLastRun(atLast, narrowed);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'flaky' });
    expect(byTitle(folded).get('A#0')?.attempts.map((entry) => entry.status)).toEqual(['failed', 'passed']);
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'passed', selected: true });
    expect(folded.run.status).toBe('passed');
  });

  it("shows a carried serial member's group, where its attempts live", () => {
    const memberTestId = 'tests/example.e2e.ts::wizard::step%20one';
    const member = result({ title: ['wizard', 'step one'], status: 'failed', serialGroupId: 'g1' });
    const group = serialGroup('g1', memberTestId, 'failed');
    const narrowed = report({
      results: [{ ...member, status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }],
      carried: { results: [member], serialGroups: [group], errors: [] },
    });
    const folded = foldLastRun(narrowed, report({ results: [{ ...member, status: 'skipped', selected: false, skip: leftOut }] }));
    expect(folded.run.serialGroups).toEqual([group]);
    expect(folded.run.status).toBe('failed');
    expect(renderMarkdownReport(folded)).toContain('step one broke');
  });

  it('leaves the rerun alone when the run before is another project\'s', () => {
    const other = report({ projectId: 'dev.example.other', status: 'failed', results: firstPass.run.results });
    expect(foldLastRun(rerun, other)).toBe(rerun);
  });
});
