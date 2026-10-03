/** Deadline and handle ownership for one observation capture operation. */

import type { JSHandle } from 'playwright-core';
import { EngineError, raceAbort, withTimeout } from 'e2e/engine';
import { cancelled } from './support.ts';

/** Releases acquired and late-arriving handles without waiting on the transport. */
export class CaptureScope {
  private active = true;
  private readonly handles = new Set<JSHandle>();

  constructor(readonly deadline: number, private readonly signal: AbortSignal) {}

  /** Runs the complete operation, including readback, within one absolute deadline. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.check();
      const result = await withTimeout(
        raceAbort(work, this.signal, 'observe'),
        this.deadline - Date.now(),
        captureTimeout,
      );
      this.check();
      return result;
    } finally {
      this.active = false;
      for (const handle of this.handles) void handle.dispose().catch(() => undefined);
      this.handles.clear();
    }
  }

  /** Stops abandoned work before its next read or mutation; receives late handles for disposal. */
  async read<T>(work: () => Promise<T>, receive?: (value: T) => void): Promise<T> {
    this.check();
    const value = await work();
    receive?.(value);
    this.check();
    return value;
  }

  /** Takes ownership even when the operation ended before the handle arrived. */
  own(handle: JSHandle): boolean {
    if (this.active) this.handles.add(handle);
    else void handle.dispose().catch(() => undefined);
    return this.active;
  }

  /** Transfers a successfully captured element to the enclosing capture or published generation. */
  release(handle: JSHandle): void {
    this.handles.delete(handle);
  }

  /** Refuses further work after cancellation, expiry, or completion. */
  check(): void {
    if (this.signal.aborted) throw cancelled('observe cancelled');
    if (!this.active || Date.now() >= this.deadline) throw captureTimeout();
  }
}

/** A capture timeout is recoverable only through the caller's explicit pixel policy. */
function captureTimeout(): EngineError {
  return new EngineError('OPERATION_TIMEOUT', 'observation capture timed out', { retryable: false });
}
