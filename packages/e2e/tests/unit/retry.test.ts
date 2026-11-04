import { describe, expect, it } from 'vitest';
import { isCutSerialRetry, isRetryEligible, retryVerdict, runWithRetries, type RetryAttempt } from '../../src/run/retry.ts';
import type { SerializedError } from '../../src/internal/errors.ts';

function error(category: SerializedError['category']): SerializedError {
  return { category, code: 'X', message: 'x', retryable: false };
}

describe('isRetryEligible', () => {
  it('accepts timeouts regardless of error category', () => {
    expect(isRetryEligible({ status: 'timed-out' }, ['test'])).toBe(true);
    expect(isRetryEligible({ status: 'timed-out', error: error('infrastructure') }, ['test'])).toBe(true);
  });

  it('accepts failures only with a test-category error', () => {
    expect(isRetryEligible({ status: 'failed', error: error('test') }, ['test'])).toBe(true);
    expect(isRetryEligible({ status: 'failed', error: error('infrastructure') }, ['test'])).toBe(false);
    expect(isRetryEligible({ status: 'failed', error: error('configuration') }, ['test'])).toBe(false);
    expect(isRetryEligible({ status: 'failed', error: error('internal') }, ['test'])).toBe(false);
    expect(isRetryEligible({ status: 'failed' }, ['test'])).toBe(false);
  });

  it('accepts the categories retryOn names', () => {
    expect(isRetryEligible({ status: 'failed', error: error('infrastructure') }, ['test', 'infrastructure'])).toBe(true);
    expect(isRetryEligible({ status: 'failed', error: error('infrastructure') }, ['infrastructure'])).toBe(true);
    expect(isRetryEligible({ status: 'failed', error: error('test') }, ['infrastructure'])).toBe(false);
    expect(isRetryEligible({ status: 'failed', error: error('configuration') }, ['test', 'infrastructure'])).toBe(false);
    expect(isRetryEligible({ status: 'timed-out', error: error('infrastructure') }, ['test'])).toBe(true);
  });
});

describe('runWithRetries', () => {
  const liveSignal = () => new AbortController().signal;

  it('returns passed on a clean first attempt without retrying', async () => {
    const attempts: number[] = [];
    const status = await runWithRetries(3, liveSignal(), async (index) => {
      attempts.push(index);
      return { status: 'passed' };
    }, ['test']);
    expect(status).toBe('passed');
    expect(attempts).toEqual([0]);
  });

  it('returns flaky when a retry passes after a test failure', async () => {
    const status = await runWithRetries(3, liveSignal(), async (index) =>
      index === 0 ? { status: 'failed', error: error('test') } : { status: 'passed' },
      ['test'],
    );
    expect(status).toBe('flaky');
  });

  it('exhausts the budget and reports the last status', async () => {
    const attempts: number[] = [];
    const status = await runWithRetries(3, liveSignal(), async (index) => {
      attempts.push(index);
      return { status: index === 2 ? 'timed-out' : 'failed', error: error('test') } as RetryAttempt;
    }, ['test']);
    expect(status).toBe('timed-out');
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('stops immediately on a non-retryable failure', async () => {
    const attempts: number[] = [];
    const status = await runWithRetries(3, liveSignal(), async (index) => {
      attempts.push(index);
      return { status: 'failed', error: error('infrastructure') };
    }, ['test']);
    expect(status).toBe('failed');
    expect(attempts).toEqual([0]);
  });

  it('returns flaky when a retry passes after an infrastructure failure', async () => {
    const status = await runWithRetries(3, liveSignal(), async (index) =>
      index === 0 ? { status: 'failed', error: error('infrastructure') } : { status: 'passed' },
      ['test', 'infrastructure'],
    );
    expect(status).toBe('flaky');
  });

  it('exhausts the retryOn budget for infrastructure failures', async () => {
    const attempts: number[] = [];
    const status = await runWithRetries(3, liveSignal(), async (index) => {
      attempts.push(index);
      return { status: 'failed', error: error('infrastructure') };
    }, ['test', 'infrastructure']);
    expect(status).toBe('failed');
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('does not retry infrastructure failures when retryOn omits them', async () => {
    const attempts: number[] = [];
    const status = await runWithRetries(3, liveSignal(), async (index) => {
      attempts.push(index);
      return { status: 'failed', error: error('infrastructure') };
    }, ['test']);
    expect(status).toBe('failed');
    expect(attempts).toEqual([0]);
  });

  it('returns interrupted without consuming further attempts', async () => {
    const attempts: number[] = [];
    const status = await runWithRetries(3, liveSignal(), async (index) => {
      attempts.push(index);
      return { status: 'interrupted' };
    }, ['test']);
    expect(status).toBe('interrupted');
    expect(attempts).toEqual([0]);
  });

  it('returns skipped when the body skipped itself, without retrying', async () => {
    const attempts: number[] = [];
    const status = await runWithRetries(3, liveSignal(), async (index) => {
      attempts.push(index);
      return { status: 'skipped' };
    }, ['test']);
    expect(status).toBe('skipped');
    expect(attempts).toEqual([0]);
  });

  it('keeps the failed verdict when an interrupt cuts its retry short', async () => {
    const status = await runWithRetries(3, liveSignal(), async (index) =>
      index === 0 ? { status: 'failed', error: error('test') } : { status: 'interrupted' },
      ['test'],
    );
    expect(status).toBe('failed');
    const timedOut = await runWithRetries(3, liveSignal(), async (index) => ({ status: index === 0 ? 'timed-out' : 'interrupted' }), ['test']);
    expect(timedOut).toBe('timed-out');
  });

  it('runs nothing when the interrupt signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    const status = await runWithRetries(3, controller.signal, async () => {
      ran += 1;
      return { status: 'passed' };
    }, ['test']);
    expect(status).toBe('failed');
    expect(ran).toBe(0);
  });

  it('stops the loop between attempts when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const attempts: number[] = [];
    const status = await runWithRetries(5, controller.signal, async (index) => {
      attempts.push(index);
      controller.abort();
      return { status: 'failed', error: error('test') };
    }, ['test']);
    expect(status).toBe('failed');
    expect(attempts).toEqual([0]);
  });

  it('stops when an attempt could not start and keeps the prior status', async () => {
    const status = await runWithRetries(3, liveSignal(), async (index) =>
      index === 0 ? { status: 'timed-out' } : undefined,
      ['test'],
    );
    expect(status).toBe('timed-out');
  });

  it('returns failed when the very first attempt cannot start', async () => {
    const status = await runWithRetries(3, liveSignal(), async () => undefined, ['test']);
    expect(status).toBe('failed');
  });
});

describe('retryVerdict', () => {
  const failed: RetryAttempt = { status: 'failed', error: error('test') };

  it.each<[readonly RetryAttempt[], string]>([
    [[], 'failed'],
    [[{ status: 'passed' }], 'passed'],
    [[failed, { status: 'passed' }], 'flaky'],
    [[failed, { status: 'timed-out' }], 'timed-out'],
    [[{ status: 'interrupted' }], 'interrupted'],
    [[{ status: 'timed-out' }, { status: 'interrupted' }], 'timed-out'],
    [[failed, { status: 'skipped' }], 'skipped'],
  ])('reads %j as %s', (attempts, verdict) => {
    expect(retryVerdict(attempts)).toBe(verdict);
  });
});

describe('isCutSerialRetry', () => {
  it.each(['passed', 'failed', 'timed-out', 'interrupted'] as const)('keeps the first %s attempt even when it never reached members', (status) => {
    expect(isCutSerialRetry(status, 0, false)).toBe(false);
    expect(isCutSerialRetry(status, 0, true)).toBe(false);
  });

  it.each(['failed', 'timed-out'] as const)('cuts an unreached %s retry but keeps a reached one', (status) => {
    expect(isCutSerialRetry(status, 1, false)).toBe(true);
    expect(isCutSerialRetry(status, 1, true)).toBe(false);
  });

  it('cuts an interrupted retry even after it reached members', () => {
    expect(isCutSerialRetry('interrupted', 1, true)).toBe(true);
  });
});