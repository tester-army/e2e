/** Deadline and cancellation helpers. */

import { E2EError } from './errors.ts';

export class Deadline {
  readonly startedAt: number;
  readonly endsAt: number;

  constructor(timeoutMs: number, now: number = Date.now()) {
    this.startedAt = now;
    this.endsAt = now + timeoutMs;
  }

  /** How long has passed since the deadline was set: the wait it timed, on its own clock. */
  elapsed(now: number = Date.now()): number {
    return Math.max(0, now - this.startedAt);
  }

  /** Remaining budget in ms, never negative. */
  remaining(now: number = Date.now()): number {
    return Math.max(0, this.endsAt - now);
  }

  expired(now: number = Date.now()): boolean {
    return now >= this.endsAt;
  }

  /**
   * A deadline that ends when the earlier of the two does, started now: the
   * wait it times is the one beginning here, not the one the earlier
   * deadline (an attempt's whole budget, say) was set for.
   */
  static min(a: Deadline, b: Deadline, now: number = Date.now()): Deadline {
    return new Deadline(Math.min(a.endsAt, b.endsAt) - now, now);
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

/** Signal for operations that only end when they finish, such as cleanup. */
export const NEVER_ABORTS = new AbortController().signal;

/**
 * Runs one lifecycle hook under a budget: the signal handed to `run` follows
 * `parent` and is aborted the moment the call fails, timeout included, so a
 * hook that outlived its budget is told to stop instead of running on.
 * Synchronous throws are caught. Callers translate the failure themselves.
 */
export async function withScopedBudget<T>(
  timeoutMs: number,
  parent: AbortSignal,
  onTimeout: () => Error,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const scope = new AbortController();
  try {
    return await withTimeout(
      Promise.resolve().then(() => run(AbortSignal.any([parent, scope.signal]))),
      timeoutMs,
      onTimeout,
    );
  } catch (cause) {
    scope.abort();
    throw cause;
  }
}

/**
 * Races a promise against an abort signal; on abort invokes onAbort to build
 * the error. The promise is left running: the caller is abandoning it.
 */
export async function withAbort<T>(
  work: Promise<T> | (() => Promise<T>),
  signal: AbortSignal,
  onAbort: () => Error,
): Promise<T> {
  if (signal.aborted) {
    if (typeof work !== 'function') void work.catch(() => undefined);
    throw onAbort();
  }
  const promise = typeof work === 'function' ? work() : work;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw onAbort();
  }
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

/** Best-effort cleanup: abandon the wait at cancellation or timeout, absorbing late failures. */
export function withinCleanupBudget(
  promise: Promise<unknown>,
  budget: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      budget.signal.removeEventListener('abort', settle);
      resolve();
    };
    const timer = setTimeout(settle, Math.max(0, budget.timeoutMs));
    budget.signal.addEventListener('abort', settle, { once: true });
    promise.then(settle, settle);
    if (budget.signal.aborted) settle();
  });
}
