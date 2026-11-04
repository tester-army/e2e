import { describe, expect, it } from 'vitest';
import type { ReportResult, ReportSerialAttempt, ReportSerialGroup } from '../../src/report/build.ts';
import { outcome } from '../../src/report/outcome.ts';
import { REPORT_AT, reportAttempt, reportError, reportResult } from '../helpers/report.ts';

function serialAttempt(index: number, status: 'failed' | 'interrupted', durationMs: number): ReportSerialAttempt {
  return {
    ...reportAttempt({ index, status }),
    status,
    members: [{ id: `member-${index}`, index: 0, testId: 'test-1', status: 'passed', startedAt: REPORT_AT, durationMs, steps: [], secondaryErrors: [] }],
  };
}

function serialOutcome(attempts: ReportSerialGroup['attempts'], status: ReportResult['status'] = 'passed') {
  const group: ReportSerialGroup = {
    id: 'group-1',
    serialId: 'checkout',
    declarationIndex: 0,
    file: 'tests/checkout.e2e.ts',
    source: { file: 'tests/checkout.e2e.ts', line: 1, column: 1 },
    titlePath: ['checkout'],
    targetId: 'web',
    platform: 'web',
    agent: 'default',
    repeat: 0,
    memberTestIds: ['test-1'],
    status: 'failed',
    attempts,
  };
  return outcome(reportResult({ status, serialGroupId: group.id, attempts: [] }), new Map([[group.id, group]]));
}

describe('serial verdict attempt', () => {
  it('retains the earlier passed member when an older report has an interrupted retry', () => {
    const result = serialOutcome([serialAttempt(0, 'failed', 1200), serialAttempt(1, 'interrupted', 300)]);
    expect(result.durationMs).toBe(1200);
    expect(result.verdict.durationMs).toBe(1200);
    expect(result.final.durationMs).toBe(300);
    expect(result.attempts.map((attempt) => attempt.durationMs)).toEqual([1200, 300]);
  });

  it.each([true, false])('reads the runner decision when a failed retry cutRetry is %s', (cutRetry) => {
    const error = reportError({ message: 'member assertion failed' });
    const launchError = reportError({ message: 'retry launch failed' });
    const original = serialAttempt(0, 'failed', 1250);
    original.members = [{ ...original.members[0]!, status: 'failed', error }];
    const retry = serialAttempt(1, 'failed', 0);
    retry.cutRetry = cutRetry;
    retry.members = [{ ...retry.members[0]!, status: 'failed', error: launchError }];
    const result = serialOutcome([original, retry], 'failed');
    expect(result.durationMs).toBe(cutRetry ? 1250 : 0);
    expect(result.verdict.error).toBe(cutRetry ? error : launchError);
    expect(result.final.error).toBe(launchError);
    expect(result.attempts).toHaveLength(2);
  });
});
