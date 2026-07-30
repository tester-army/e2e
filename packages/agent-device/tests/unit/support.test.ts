/** Deadline and cancellation plumbing shared by every daemon round trip. */

import { describe, expect, it } from 'vitest';
import { withDeadline } from '../../src/support.ts';

/** A real signal that reports how many listeners are currently attached. */
function countingSignal(): { signal: AbortSignal; attached: () => number; abort: () => void } {
  const controller = new AbortController();
  const signal = controller.signal;
  let attached = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperties(signal, {
    addEventListener: {
      value: (...args: Parameters<AbortSignal['addEventListener']>) => {
        attached += 1;
        add(...args);
      },
    },
    removeEventListener: {
      value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
        attached -= 1;
        remove(...args);
      },
    },
  });
  return { signal, attached: () => attached, abort: () => controller.abort() };
}

describe('withDeadline', () => {
  it('detaches its cancellation listener when the call completes', async () => {
    // One attempt-scoped signal serves every round trip of the whole test, so a
    // listener left behind by a completed call accumulates until the test ends.
    const { signal, attached } = countingSignal();
    const operation = { signal, timeoutMs: 5_000 };
    for (let call = 0; call < 20; call += 1) {
      await withDeadline(Promise.resolve(call), operation, 'snapshot');
    }
    expect(attached()).toBe(0);
  });

  it('detaches its cancellation listener when the call rejects', async () => {
    const { signal, attached } = countingSignal();
    const operation = { signal, timeoutMs: 5_000 };
    await expect(
      withDeadline(Promise.reject(new Error('daemon closed')), operation, 'snapshot'),
    ).rejects.toThrow('daemon closed');
    expect(attached()).toBe(0);
  });

  it('cancels an in-flight call when the operation aborts', async () => {
    const { signal, abort } = countingSignal();
    const pending = withDeadline(new Promise<never>(() => {}), { signal, timeoutMs: 5_000 }, 'tap');
    abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('fails a call that outlives its budget', async () => {
    const controller = new AbortController();
    await expect(
      withDeadline(new Promise<never>(() => {}), { signal: controller.signal, timeoutMs: 1 }, 'tap'),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('rejects immediately when the operation is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withDeadline(Promise.resolve(1), { signal: controller.signal, timeoutMs: 5_000 }, 'tap'),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
