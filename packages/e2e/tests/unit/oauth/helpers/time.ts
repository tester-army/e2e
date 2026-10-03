import { vi } from 'vitest';

/**
 * Settles `work` with `setTimeout` on fake time, so a device-flow poll interval
 * or a refresh-rotation wait costs no wall time. The clock steps rather than
 * jumps, with a real event-loop turn before each step, so a request to a local
 * server still completes between the waits.
 */
export async function onFakeTimeouts<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const result = work();
    const settled = result.then(
      () => true,
      () => true,
    );
    const realTurn = () => new Promise<boolean>((resolve) => setImmediate(() => resolve(false)));
    while (!(await Promise.race([settled, realTurn()]))) await vi.advanceTimersByTimeAsync(50);
    return await result;
  } finally {
    vi.useRealTimers();
  }
}
