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
  });

  it('reports expiry at and after the boundary', () => {
    const deadline = new Deadline(100, 0);
    expect(deadline.expired(99)).toBe(false);
    expect(deadline.expired(100)).toBe(true);
    expect(deadline.expired(101)).toBe(true);
  });

  it('min returns the earlier deadline and prefers the first on ties', () => {
    const early = new Deadline(100, 0);
    const late = new Deadline(200, 0);
    expect(Deadline.min(early, late)).toBe(early);
    expect(Deadline.min(late, early)).toBe(early);
    const tie = new Deadline(100, 0);
    expect(Deadline.min(early, tie)).toBe(early);
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
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
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

  it('supports an async onTimeout error factory', async () => {
    vi.useFakeTimers();
    const promise = pollCondition({
      deadline: new Deadline(100),
      signal: new AbortController().signal,
      negated: false,
      evaluate: async () => false,
      onTimeout: async () => new Error('async timeout'),
    });
    const assertion = expect(promise).rejects.toThrow('async timeout');
    await vi.advanceTimersByTimeAsync(500);
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

  it('propagates rejection of the underlying promise', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, () => new Error('unused')),
    ).rejects.toThrow('boom');
  });
});
