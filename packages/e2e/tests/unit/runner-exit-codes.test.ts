/**
 * `verdictExitCodes` in `src/run/runner.ts`: the exit-code fold over run
 * verdicts, including the regression for #1231 — a passed test whose
 * cleanup failed (a required video that could not be finalized) must not
 * leave the run at exit 0.
 */

import { describe, expect, it } from 'vitest';
import { combineExitCodes, type SerializedError } from '../../src/internal/errors.ts';
import type {
  AttemptRecord,
  ResultRecord,
  ResultStatus,
  SerialAttemptRecord,
  SerialGroupRecord,
} from '../../src/run/records.ts';
import { verdictExitCodes } from '../../src/run/runner.ts';

const AT = '2026-01-01T00:00:00.000Z';

/** The secondary error `stopVideo` records when a required video cannot be finalized. */
function cleanupTimeoutError(): SerializedError {
  return {
    category: 'infrastructure',
    code: 'CLEANUP_TIMEOUT',
    message: 'stopping the video timed out',
    retryable: false,
    phase: 'cleanup',
  };
}

/** One attempt of a test that passed its body, with the given cleanup state. */
function attempt(cleanup: AttemptRecord['cleanup'], secondaryErrors: SerializedError[] = []): AttemptRecord {
  return {
    id: 'attempt-1',
    index: 0,
    status: 'passed',
    startedAt: AT,
    durationMs: 10,
    steps: [],
    artifacts: [],
    secondaryErrors,
    cleanup,
  };
}

/** A result for one test with the given verdict status and attempts. */
function result(status: ResultStatus, attempts: AttemptRecord[]): ResultRecord {
  return {
    test: {
      kind: 'test',
      title: 'case',
      titlePath: ['suite', 'case'],
      declarationIndex: 0,
      sessions: [],
      tags: [],
      source: undefined,
      file: 'tests/case.e2e.ts',
      id: 'tests/case.e2e.ts::suite::case',
      serialId: undefined,
    },
    target: {
      name: 'web',
      index: 0,
      platform: 'web',
      engine: undefined,
      app: { base: undefined, site: undefined, environment: 'test', identity: undefined },
    } as unknown as ResultRecord['target'],
    agent: 'default',
    repeat: 0,
    status,
    selected: true,
    attempts,
  };
}

/** A serial group whose one attempt carries the given cleanup state. */
function serialGroup(cleanup: SerialAttemptRecord['cleanup'], secondaryErrors: SerializedError[] = []): SerialGroupRecord {
  return {
    id: 'group-1',
    serialId: 'serial-1',
    declarationIndex: 0,
    file: 'tests/case.e2e.ts',
    titlePath: ['suite', 'group'],
    targetId: 'web',
    platform: 'web',
    agent: 'default',
    repeat: 0,
    memberTestIds: ['tests/case.e2e.ts::suite::case'],
    status: 'passed',
    attempts: [
      {
        id: 'group-attempt-1',
        index: 0,
        status: 'passed',
        startedAt: AT,
        durationMs: 10,
        members: [],
        artifacts: [],
        secondaryErrors,
        cleanup,
      },
    ],
  };
}

/** The exit code the runner's fold reports for the given verdicts. */
function exitCodeFor(results: ResultRecord[], serialGroups: SerialGroupRecord[] = []): number {
  return combineExitCodes(verdictExitCodes(results, serialGroups));
}

describe('verdictExitCodes', () => {
  it('exits 0 when a passed test cleaned up completely', () => {
    expect(exitCodeFor([result('passed', [attempt('complete')])])).toBe(0);
  });

  it('exits 3 when a passed test failed to finalize its required video (#1231)', () => {
    const codes = verdictExitCodes([result('passed', [attempt('failed', [cleanupTimeoutError()])])], []);
    expect(codes).toContain(3);
    expect(exitCodeFor([result('passed', [attempt('failed', [cleanupTimeoutError()])])])).toBe(3);
  });

  it('exits 3 on a cleanup failure with no recorded secondary error', () => {
    expect(exitCodeFor([result('passed', [attempt('failed')])])).toBe(3);
  });

  it('uses the cleanup-phase secondary error category when it differs', () => {
    const error: SerializedError = { ...cleanupTimeoutError(), category: 'internal' };
    expect(exitCodeFor([result('passed', [attempt('failed', [error])])])).toBe(4);
  });

  it('keeps the highest-precedence code across several cleanup errors', () => {
    const errors: SerializedError[] = [
      cleanupTimeoutError(),
      { ...cleanupTimeoutError(), code: 'SESSION_CLOSE_FAILED', category: 'internal' },
    ];
    expect(exitCodeFor([result('passed', [attempt('failed', errors)])])).toBe(4);
  });

  it('ignores a forced cleanup: the interrupt already sets the code', () => {
    expect(exitCodeFor([result('passed', [attempt('forced', [cleanupTimeoutError()])])])).toBe(0);
  });

  it('ignores body-phase secondary errors when cleanup completed', () => {
    const error: SerializedError = { ...cleanupTimeoutError(), phase: 'body' };
    expect(exitCodeFor([result('passed', [attempt('complete', [error])])])).toBe(0);
  });

  it('exits 3 for a serial group attempt whose cleanup failed', () => {
    expect(exitCodeFor([], [serialGroup('failed', [cleanupTimeoutError()])])).toBe(3);
  });

  it('a failed test with a failed cleanup keeps the worse code', () => {
    const failedAttempt: AttemptRecord = {
      ...attempt('failed', [cleanupTimeoutError()]),
      status: 'failed',
      error: {
        category: 'test',
        code: 'EXPECT_FAILED',
        message: 'expect failed',
        retryable: false,
      },
    };
    expect(exitCodeFor([result('failed', [failedAttempt])])).toBe(3);
  });
});
