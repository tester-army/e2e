import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Deadline,
  NEGATION_GRACE_MS,
  POLL_INTERVAL_MS,
  pollCondition,
  sleep,
  withTimeout,
} from '../../src/internal/time.ts';
import { E2EError } from '../../src/internal/errors.ts';
import { EngineError } from '../../src/engine/contract.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('Deadline', () => {
  it('computes remaining budget and never goes negative', () => {
    const deadline = new Deadline(1000, 5000);
    expect(deadline.endsAt).toBe(6000);
    expect(deadline.remaining(5000)).toBe(1000);
    expect(deadline.remaining(5900)).toBe(100);
    expect(deadline.remaining(7000)).toBe(0);
    expect(deadline.expired(5999)).toBe(false);
    expect(deadline.expired(6000)).toBe(true);
  });
});

describe('sleep', () => {
  it('resolves after the given duration', async () => {
    vi.useFakeTimers();
    const promise = sleep(500);
    await vi.advanceTimersByTimeAsync(499);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(10, controller.signal)).rejects.toMatchObject({
      category: 'infrastructure',
      code: 'CANCELLED',
    });
  });

  it('rejects mid-sleep on abort and clears the timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleep(10_000, controller.signal);
    const assertion = expect(promise).rejects.toBeInstanceOf(E2EError);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its abort listener after resolving', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleep(1, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
});

describe('pollCondition', () => {
  function makeOptions(overrides: {
    negated?: boolean;
    timeoutMs?: number;
    evaluate: () => Promise<boolean | undefined>;
  }) {
    return {
      deadline: new Deadline(overrides.timeoutMs ?? 5000),
      signal: new AbortController().signal,
      negated: overrides.negated ?? false,
      evaluate: overrides.evaluate,
      onTimeout: () => new Error('poll timed out'),
    };
  }

  it('returns once the positive condition holds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = pollCondition(
      makeOptions({
        evaluate: async () => {
          calls += 1;
          return calls >= 3;
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await promise;
    expect(calls).toBe(3);
  });

  it('throws the caller error at the deadline', async () => {
    vi.useFakeTimers();
    const promise = pollCondition(
      makeOptions({ timeoutMs: 350, evaluate: async () => false }),
    );
    const assertion = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('negated: a budget shorter than the grace window is still satisfiable', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const promise = pollCondition(
      makeOptions({ negated: true, timeoutMs: 400, evaluate: async () => false }),
    );
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(400 + POLL_INTERVAL_MS);
    expect(resolved).toBe(true);
    await promise;
  });

  it('negated: passes only after the grace window holds continuously', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const promise = pollCondition(
      makeOptions({ negated: true, timeoutMs: 60_000, evaluate: async () => false }),
    );
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(NEGATION_GRACE_MS - POLL_INTERVAL_MS);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(resolved).toBe(true);
    await promise;
  });

  it('negated: an undefined evaluation resets the grace window', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let resolved = false;
    const promise = pollCondition(
      makeOptions({
        negated: true,
        timeoutMs: 60_000,
        evaluate: async () => {
          calls += 1;
          // Hold false for a while, blip to undefined, then false again.
          return calls === 8 ? undefined : false;
        },
      }),
    );
    void promise.then(() => {
      resolved = true;
    });
    // 8th call at ~700ms resets the window; without the reset it would pass at ~1000ms.
    await vi.advanceTimersByTimeAsync(NEGATION_GRACE_MS + POLL_INTERVAL_MS * 2);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(NEGATION_GRACE_MS);
    expect(resolved).toBe(true);
    await promise;
  });

  it('negated: a true evaluation clears accumulated grace', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let resolved = false;
    const promise = pollCondition(
      makeOptions({
        negated: true,
        timeoutMs: 60_000,
        evaluate: async () => {
          calls += 1;
          return calls === 8;
        },
      }),
    );
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(NEGATION_GRACE_MS + POLL_INTERVAL_MS * 2);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(NEGATION_GRACE_MS);
    expect(resolved).toBe(true);
    await promise;
  });

  /** A negated poll whose evaluations take `firstMs`, then `restMs`, each reporting the negation; records when each read was issued. */
  function slowNegation(timeoutMs: number, firstMs: number, restMs: number) {
    const issuedAt: number[] = [];
    let resolvedAt: number | undefined;
    let rejected: unknown;
    const startedAt = Date.now();
    const promise = pollCondition(
      makeOptions({
        negated: true,
        timeoutMs,
        evaluate: async () => {
          issuedAt.push(Date.now() - startedAt);
          await new Promise((resolve) => setTimeout(resolve, issuedAt.length === 1 ? firstMs : restMs));
          return false;
        },
      }),
    );
    void promise.then(
      () => {
        resolvedAt = Date.now() - startedAt;
      },
      (cause: unknown) => {
        rejected = cause;
      },
    );
    return {
      promise,
      issuedAt,
      get resolvedAt() {
        return resolvedAt;
      },
      get rejected() {
        return rejected;
      },
    };
  }

  it('negated: a slow first read counts toward a budget shorter than the grace window', async () => {
    vi.useFakeTimers();
    const poll = slowNegation(500, 80, 10);
    await vi.advanceTimersByTimeAsync(499);
    expect(poll.resolvedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(poll.rejected).toBeUndefined();
    expect(poll.resolvedAt).toBe(500);
    // Passing at the deadline takes no read past it: that read would have no budget.
    expect(poll.issuedAt.every((at) => at < 500)).toBe(true);
    await poll.promise;
  });

  it('negated: a slow first read counts toward the grace window under a longer budget', async () => {
    vi.useFakeTimers();
    const poll = slowNegation(1500, 80, 10);
    await vi.advanceTimersByTimeAsync(NEGATION_GRACE_MS - 1);
    expect(poll.resolvedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(poll.rejected).toBeUndefined();
    expect(poll.resolvedAt).toBeGreaterThanOrEqual(NEGATION_GRACE_MS);
    expect(poll.resolvedAt).toBeLessThan(1500);
    await poll.promise;
  });

  it('negated: fast reads under a short budget pass at the deadline, not before', async () => {
    vi.useFakeTimers();
    const poll = slowNegation(500, 0, 0);
    await vi.advanceTimersByTimeAsync(499);
    expect(poll.resolvedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll.resolvedAt).toBe(500);
    await poll.promise;
  });

  it('negated: a budget shorter than the grace window still fails when the positive state was seen', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = pollCondition(
      makeOptions({
        negated: true,
        timeoutMs: 500,
        evaluate: async () => {
          calls += 1;
          return calls === 3;
        },
      }),
    );
    const assertion = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    // It decided at the deadline instead of reading past it.
    expect(calls).toBe(5);
  });

  it('stops polling when the signal aborts between evaluations', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCondition({
      deadline: new Deadline(60_000),
      signal: controller.signal,
      negated: false,
      evaluate: async () => false,
      onTimeout: () => new Error('unused'),
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS / 2);
    controller.abort();
    await assertion;
  });

  it('ends on the last sample when the deadline cuts a read off, and fails on a read the deadline did not cut', async () => {
    vi.useFakeTimers();
    const cut = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const deadline = new Deadline(350);
    let calls = 0;
    const promise = pollCondition({
      deadline,
      signal: new AbortController().signal,
      negated: false,
      evaluate: async () => {
        calls += 1;
        if (deadline.remaining() > 0) return false;
        throw cut;
      },
      onTimeout: () => new Error('poll timed out'),
    });
    const assertion = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(calls).toBeGreaterThan(1);

    const early = pollCondition({
      deadline: new Deadline(5_000),
      signal: new AbortController().signal,
      negated: false,
      evaluate: async () => { throw cut; },
      onTimeout: () => new Error('poll timed out'),
    });
    await expect(early).rejects.toBe(cut);
  });

  it('keeps a read that hung most of the wait a failure, and never lets a negation pass on it', async () => {
    vi.useFakeTimers();
    const cut = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const deadline = new Deadline(2_000);
    let calls = 0;
    const promise = pollCondition({
      deadline,
      signal: new AbortController().signal,
      negated: true,
      evaluate: async () => {
        calls += 1;
        if (calls === 1) return false;
        // The page froze: this read takes the rest of the wait and is cut at its deadline.
        await sleep(deadline.remaining());
        throw cut;
      },
      onTimeout: () => new Error('poll timed out'),
    });
    const assertion = expect(promise).rejects.toBe(cut);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('negated: a read the deadline cut off ends the poll on what held when it began', async () => {
    vi.useFakeTimers();
    const cut = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const run = (cutAfterMs: number) => {
      const startedAt = Date.now();
      const deadline = new Deadline(1_950);
      return pollCondition({
        deadline,
        signal: new AbortController().signal,
        negated: true,
        // Visible for the first 900 ms, then gone; the read that starts with under a poll tick left is cut.
        evaluate: async () => {
          if (deadline.remaining() < POLL_INTERVAL_MS) throw cut;
          return Date.now() - startedAt < cutAfterMs;
        },
        onTimeout: (cause) => Object.assign(new Error('poll timed out'), { cause }),
      });
    };
    // Gone from 900 ms: the grace window had run when the cut-off read began at 1900 ms.
    const passing = run(900);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(passing).resolves.toBeUndefined();
    // Gone from 1000 ms: it had not, and the poll fails with the cut-off read as its cause.
    const failing = run(1_000);
    const assertion = expect(failing).rejects.toMatchObject({ message: 'poll timed out', cause: cut });
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

});

describe('withTimeout', () => {
  it('returns the resolved value and clears the timer', async () => {
    vi.useFakeTimers();
    const value = await withTimeout(Promise.resolve(7), 1000, () => new Error('unused'));
    expect(value).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throws the built error when the promise does not settle in time', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const promise = withTimeout(never, 250, () => new Error('too slow'));
    const assertion = expect(promise).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});
