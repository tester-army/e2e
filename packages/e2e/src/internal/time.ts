/** Deadline and cancellation helpers. */

import { E2EError } from './errors.ts';

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

/** Canonical polling cadence for locator and assertion loops. */
export const POLL_INTERVAL_MS = 100;

/** How long a negated assertion must hold before it passes. */
export const NEGATION_GRACE_MS = 1000;

export interface PollConditionOptions {
  readonly deadline: Deadline;
  readonly signal: AbortSignal;
  readonly negated: boolean;
  /**
   * Evaluates the positive condition once. Returns undefined when the
   * condition cannot be evaluated yet: the positive poll keeps waiting and
   * the negation grace window resets.
   */
  evaluate(): Promise<boolean | undefined>;
  onTimeout(): Error | Promise<Error>;
}

/**
 * Polls a condition until it holds (or, when negated, until its negation has
 * held continuously for the negation grace window), throwing the caller's
 * error at the deadline.
 */
export async function pollCondition(options: PollConditionOptions): Promise<void> {
  // A budget shorter than the grace window still has to be satisfiable: the
  // negation then only needs to hold for the budget itself.
  const grace = Math.min(NEGATION_GRACE_MS, Math.max(0, options.deadline.remaining()));
  let negatedTrueSince: number | undefined;
  for (;;) {
    const value = await options.evaluate();
    if (!options.negated) {
      if (value === true) return;
    } else if (value === false) {
      negatedTrueSince ??= Date.now();
      if (Date.now() - negatedTrueSince >= grace) return;
    } else {
      negatedTrueSince = undefined;
    }
    if (options.deadline.expired()) throw await options.onTimeout();
    await sleep(POLL_INTERVAL_MS, options.signal);
  }
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

/**
 * Races a promise against an abort signal; on abort invokes onAbort to build
 * the error. The promise is left running: the caller is abandoning it.
 */
export async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => Error,
): Promise<T> {
  if (signal.aborted) throw onAbort();
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        listener = () => reject(onAbort());
        signal.addEventListener('abort', listener, { once: true });
      }),
    ]);
  } finally {
    if (listener !== undefined) signal.removeEventListener('abort', listener);
  }
}
