/** Deadline and cancellation helpers. */

import { E2EError } from './errors.js';

export class Deadline {
  readonly endsAt: number;

  constructor(timeoutMs: number, now: number = Date.now()) {
    this.endsAt = now + timeoutMs;
  }

  /** Remaining budget in ms, never negative. */
  remaining(now: number = Date.now()): number {
    return Math.max(0, this.endsAt - now);
  }

  expired(now: number = Date.now()): boolean {
    return now >= this.endsAt;
  }

  /** Returns a deadline capped by another deadline. */
  static min(a: Deadline, b: Deadline): Deadline {
    return a.endsAt <= b.endsAt ? a : b;
  }
}

/** Sleeps for ms, rejecting early if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new E2EError('infrastructure', 'CANCELLED', 'operation cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new E2EError('infrastructure', 'CANCELLED', 'operation cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Races a promise against a timeout; on timeout invokes onTimeout to build the error. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
