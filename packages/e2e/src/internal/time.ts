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

/** The most a negated assertion must hold before it passes. */
export const NEGATION_GRACE_MS = 1000;

/**
 * How long a negation must hold for a budget: the grace, or half the budget
 * when that is shorter, so a short `{ timeout }` leaves the negation room to
 * begin.
 */
function negationWindow(budgetMs: number): number {
  return Math.min(NEGATION_GRACE_MS, Math.floor(Math.max(0, budgetMs) / 2));
}

/** A negated poll that ran out of time while its last sample held the negation. */
export interface NegationTimeout {
  /** How long the negation had held at the last sample. */
  readonly heldMs: number;
  /** How long it had to hold. */
  readonly windowMs: number;
}

/** What `pollCondition` knows when it gives up, for the caller's failure message. */
export interface PollTimeout {
  /** Present when the poll was negated and its last sample satisfied the negation. */
  readonly negation?: NegationTimeout;
}

export interface PollConditionOptions {
  readonly deadline: Deadline;
  readonly signal: AbortSignal;
  readonly negated: boolean;
  /**
   * Evaluates the positive condition once, within `deadline`: the caller's
   * until it passes, then the negation window a negation that began in time
   * may finish in. Returns undefined when the condition cannot be evaluated
   * yet: the positive poll keeps waiting and the negation window resets.
   */
  evaluate(deadline: Deadline): Promise<boolean | undefined>;
  onTimeout(timeout: PollTimeout): Error | Promise<Error>;
}

/**
 * Polls a condition until it holds, throwing the caller's error at the
 * deadline. Negated, the condition must have stopped holding by the deadline
 * and then stay that way for the negation window, which may run past the
 * deadline by at most the window itself; a sample that breaks the hold once
 * the deadline has passed fails the poll at once, and so does one that
 * completes the hold after the extended deadline, however long it held.
 */
export async function pollCondition(options: PollConditionOptions): Promise<void> {
  const { deadline } = options;
  const windowMs = negationWindow(deadline.remaining());
  const extended = new Deadline(windowMs, deadline.endsAt);
  let heldSince: number | undefined;
  let within = deadline;
  for (;;) {
    const value = await options.evaluate(within);
    const now = Date.now();
    if (!options.negated) {
      if (value === true) return;
    } else if (value === false) {
      heldSince ??= now;
      if (now - heldSince >= windowMs && now <= extended.endsAt) return;
    } else {
      heldSince = undefined;
    }
    if (deadline.expired(now)) {
      if (heldSince === undefined || extended.expired(now)) {
        throw await options.onTimeout(
          heldSince === undefined ? {} : { negation: { heldMs: now - heldSince, windowMs } },
        );
      }
      within = extended;
    }
    await sleep(POLL_INTERVAL_MS, options.signal);
  }
}

/**
 * The failure line for a negation that held at the last sample: for less than
 * its window, or for the window but confirmed by a sample that landed after
 * the window had closed.
 */
export function describeNegationTimeout(negation: NegationTimeout): string {
  return negation.heldMs < negation.windowMs
    ? `held for ${negation.heldMs} ms, short of the ${negation.windowMs} ms negation window`
    : `held for ${negation.heldMs} ms, confirmed only after the ${negation.windowMs} ms negation window closed`;
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
