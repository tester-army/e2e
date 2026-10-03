/**
 * The cancellation and cleanup primitives every engine wraps its calls in:
 * `raceAbort` never dispatches cancelled work and never leaks the rejection of
 * work it abandoned, and `withinCleanupBudget` never outlives its budget.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { raceAbort, withinCleanupBudget } from '../../src/engine/index.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('raceAbort', () => {
  it('refuses an already-aborted signal before dispatching the work', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn(async () => 'ran');
    await expect(raceAbort(work, controller.signal, 'call')).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'call cancelled',
      retryable: false,
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('abandons pending work at abort and absorbs its late rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const controller = new AbortController();
      let reject!: (cause: unknown) => void;
      const abandoned = new Promise<never>((_resolve, r) => {
        reject = r;
      });
      const raced = raceAbort(abandoned, controller.signal, 'call');
      controller.abort();
      await expect(raced).rejects.toMatchObject({ code: 'CANCELLED' });
      reject(new Error('late'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('withinCleanupBudget', () => {
  it('resolves when the work fails, without rethrowing', async () => {
    const budget = { signal: new AbortController().signal, timeoutMs: 1_000 };
    await expect(withinCleanupBudget(Promise.reject(new Error('close failed')), budget)).resolves.toBeUndefined();
  });

  it('resolves at abort while the work still hangs', async () => {
    const controller = new AbortController();
    const waiting = withinCleanupBudget(new Promise<never>(() => undefined), { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });

  it('resolves once the budget elapses while the work still hangs, and not before', async () => {
    vi.useFakeTimers();
    let settled = false;
    void withinCleanupBudget(new Promise<never>(() => undefined), { signal: new AbortController().signal, timeoutMs: 500 }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});
