import { describe, expect, it } from 'vitest';
import { publishAttempt } from '../../src/expect/attempt.ts';
import { SoftFailures } from '../../src/expect/soft.ts';
import { serializeError, TestError, type SerializedError } from '../../src/internal/errors.ts';
import { expectedFailureOption, markRunningTestExpectedToFail, type ExpectedFailureInfo } from '../../src/internal/expected-failure.ts';
import { settleExpectedFailure } from '../../src/run/expected-failure.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { Deadline } from '../../src/internal/time.ts';

type Attempt = {
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  error?: SerializedError;
  skip?: { cause: 'explicit'; reason: string };
  secondaryErrors: SerializedError[];
  expectedFailure?: ExpectedFailureInfo;
};

const failure = (category: SerializedError['category'], code = 'ASSERTION_FAILED'): SerializedError => ({ category, code, message: 'expected 1, got 0', retryable: false });
const settle = (attempt: Attempt, reason: string | undefined, redact = (text: string) => text): Attempt => {
  settleExpectedFailure(attempt, reason, { serialize: (error) => serializeError(error, { redact }), redact });
  return attempt;
};

describe('settleExpectedFailure', () => {
  it('leaves an unmarked attempt alone', () => {
    expect(settle({ status: 'failed', error: failure('test'), secondaryErrors: [] }, undefined)).toEqual({ status: 'failed', error: failure('test'), secondaryErrors: [] });
  });

  it('passes a test failure or timeout, keeping the error beside the reason', () => {
    expect(settle({ status: 'failed', error: failure('test'), secondaryErrors: [] }, 'known gap')).toEqual({
      status: 'passed',
      secondaryErrors: [],
      expectedFailure: { reason: 'known gap', error: failure('test') },
    });
    const timeout = failure('test', 'TEST_TIMEOUT');
    expect(settle({ status: 'timed-out', error: timeout, secondaryErrors: [] }, 'slow')).toEqual({ status: 'passed', secondaryErrors: [], expectedFailure: { reason: 'slow', error: timeout } });
  });

  it('fails a pass with UNEXPECTED_PASS naming the reason', () => {
    const settled = settle({ status: 'passed', secondaryErrors: [] }, 'known gap');
    expect(settled.status).toBe('failed');
    expect(settled.error).toMatchObject({ category: 'test', code: 'UNEXPECTED_PASS', retryable: false });
    expect(settled.error?.message).toContain('"known gap"');
    expect(settled.expectedFailure).toEqual({ reason: 'known gap' });
  });

  it('keeps infrastructure failures and interrupts as they are, recording the mark', () => {
    const engine = failure('infrastructure', 'ENGINE_FAILURE');
    expect(settle({ status: 'failed', error: engine, secondaryErrors: [] }, 'gap')).toMatchObject({ status: 'failed', error: engine, expectedFailure: { reason: 'gap' } });
    const interrupted = failure('interrupted', 'INTERRUPTED');
    expect(settle({ status: 'interrupted', error: interrupted, secondaryErrors: [] }, 'gap')).toMatchObject({ status: 'interrupted', error: interrupted, expectedFailure: { reason: 'gap' } });
  });

  it('does not cover a blocked agent verdict', () => {
    const blocked = failure('test', 'STEP_BUDGET_EXHAUSTED');
    expect(settle({ status: 'failed', error: blocked, secondaryErrors: [] }, 'gap')).toMatchObject({ status: 'failed', error: blocked, expectedFailure: { reason: 'gap' } });
  });

  it('does not cover a test failure with an infrastructure error beside it outside cleanup', () => {
    const crash = { ...failure('infrastructure', 'ENGINE_FAILURE'), phase: 'afterEach' as const };
    expect(settle({ status: 'failed', error: failure('test'), secondaryErrors: [crash] }, 'gap').status).toBe('failed');
    const cleanup = { ...crash, phase: 'cleanup' as const };
    expect(settle({ status: 'failed', error: failure('test'), secondaryErrors: [cleanup] }, 'gap').status).toBe('passed');
  });

  it('does not cover a test that misuses the API or a failed suite hook', () => {
    for (const code of ['INVALID_ARGUMENT', 'INVALID_LOCATOR', 'UNSUPPORTED_CAPABILITY', 'STEP_NOT_AWAITED']) {
      expect(settle({ status: 'failed', error: failure('test', code), secondaryErrors: [] }, 'gap').status, code).toBe('failed');
    }
    const hook = { ...failure('test', 'HOOK_FAILED'), phase: 'beforeAll' as const };
    expect(settle({ status: 'failed', error: hook, secondaryErrors: [] }, 'gap')).toMatchObject({ status: 'failed', error: hook, expectedFailure: { reason: 'gap' } });
    const misuse = { ...failure('test', 'STEP_NOT_AWAITED'), phase: 'body' as const };
    expect(settle({ status: 'failed', error: failure('test'), secondaryErrors: [misuse] }, 'gap').status).toBe('failed');
  });

  it('redacts and bounds the reason', () => {
    const covered = settle({ status: 'failed', error: failure('test'), secondaryErrors: [] }, 'token hunter2 leaks', (text) => text.replaceAll('hunter2', '[REDACTED]'));
    expect(covered.expectedFailure?.reason).toBe('token [REDACTED] leaks');
    const unexpected = settle({ status: 'passed', secondaryErrors: [] }, 'hunter2', (text) => text.replaceAll('hunter2', '[REDACTED]'));
    expect(unexpected.error?.message).not.toContain('hunter2');
    expect(Buffer.byteLength(settle({ status: 'passed', secondaryErrors: [] }, 'x'.repeat(9000)).expectedFailure!.reason)).toBe(8192);
  });

  it('lets a skip win, also beside a failure', () => {
    expect(settle({ status: 'skipped', secondaryErrors: [] }, 'gap')).toEqual({ status: 'skipped', secondaryErrors: [] });
    const skip = { cause: 'explicit' as const, reason: 'n/a' };
    expect(settle({ status: 'failed', error: failure('test'), skip, secondaryErrors: [] }, 'gap')).toEqual({ status: 'failed', error: failure('test'), skip, secondaryErrors: [] });
  });
});

describe('expectedFailureOption', () => {
  it('reads true, false, a reason, and a blank reason', () => {
    expect(expectedFailureOption(undefined)).toBeUndefined();
    expect(expectedFailureOption(false)).toBeUndefined();
    expect(expectedFailureOption(true)).toBe('expected to fail');
    expect(expectedFailureOption(' ')).toBe('expected to fail');
    expect(expectedFailureOption('known gap')).toBe('known gap');
  });
});

describe('markRunningTestExpectedToFail', () => {
  const during = (attempt: { testKind?: 'test' | 'setup'; owner?: 'suite' | 'host'; mark?: (reason: string) => void }, body: () => void): void => {
    const end = new AbortController();
    publishAttempt(
      {
        attemptId: 'a',
        owner: attempt.owner ?? 'suite',
        testKind: attempt.testKind ?? 'test',
        assertionTimeout: 1000,
        budget: new AttemptBudget(end.signal, new Deadline(1000)),
        soft: new SoftFailures(),
        ...(attempt.mark === undefined ? {} : { expectFailure: attempt.mark }),
      },
      end.signal,
    );
    try {
      body();
    } finally {
      end.abort();
    }
  };

  it('marks the running test when the condition holds, without throwing', () => {
    const reasons: string[] = [];
    during({ mark: (reason) => reasons.push(reason) }, () => {
      markRunningTestExpectedToFail(false, 'never');
      markRunningTestExpectedToFail(true, 'known gap');
      markRunningTestExpectedToFail(true, undefined);
    });
    expect(reasons).toEqual(['known gap', 'expected to fail']);
  });

  it('refuses a setup test, a serial member, and a hosted teardown', () => {
    expect(() => during({ testKind: 'setup' }, () => markRunningTestExpectedToFail(true, 'x'))).toThrow(/cannot mark a setup test/);
    expect(() => during({}, () => markRunningTestExpectedToFail(true, 'x'))).toThrow(/cannot mark a serial group member/);
    expect(() => during({ owner: 'host' }, () => markRunningTestExpectedToFail(true, 'x'))).toThrow(/cannot mark a test from an afterEach hook or a fixture teardown/);
    expect(() => during({ testKind: 'setup' }, () => markRunningTestExpectedToFail(true, 'x'))).toThrow(TestError);
  });
});
