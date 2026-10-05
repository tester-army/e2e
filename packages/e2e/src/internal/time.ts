/** Deadline and cancellation helpers. */

import { asEngineError, E2EError } from './errors.ts';

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

/**
 * Whether `cause` is a read a wait's deadline cut off: an operation timeout
 * of a read that started with less than one poll tick of the wait left, so
 * it timed out because the wait did, not because the app stopped answering.
 * A read that started with more and still timed out hung, and its timeout is
 * the failure. Reads the engine error a locator failure wraps as well as a
 * bare one.
 */
export function cutOffAtDeadline(cause: unknown, startedWithMs: number): boolean {
  if (startedWithMs >= POLL_INTERVAL_MS) return false;
  const engineError = asEngineError(cause) ?? asEngineError(cause instanceof Error ? cause.cause : undefined);
  return engineError?.code === 'OPERATION_TIMEOUT';
}

/** How long a negated assertion must hold before it passes. */
export const NEGATION_GRACE_MS = 1000;

export interface PollConditionOptions {
  readonly deadline: Deadline;
  readonly signal: AbortSignal;
  readonly negated: boolean;
  /**
   * Evaluates the positive condition once, every read bounded by
   * `deadline`: a read on a longer budget outlasts the poll. Returns
   * undefined when the condition cannot be evaluated yet: the positive poll
   * keeps waiting and the negation grace window resets.
   */
  evaluate(): Promise<boolean | undefined>;
  /** Builds the poll's failure; `cause` is the read the deadline cut off, when one did. */
  onTimeout(cause?: unknown): Error | Promise<Error>;
}

/**
 * Polls a condition until it holds (or, when negated, until its negation has
 * held continuously for the negation grace window), throwing the caller's
 * error at the deadline.
 *
 * A negation holds from the moment the read that first saw it was issued, so
 * a slow read counts toward the window. A budget shorter than the window
 * still has to be satisfiable: the negation then only needs to hold for the
 * whole budget, and passes at the deadline on what it has seen, since a read
 * past the deadline has no budget left. A read the deadline cut off (see
 * `cutOffAtDeadline`) after an earlier one completed saw nothing: the poll
 * ends there. A negation then passes if it has held long enough by the
 * time the read is cut off: the read left less than one poll tick unseen, no
 * more than the gap between any two reads, so a short budget still passes at
 * its deadline on what it saw.
 */
export async function pollCondition(options: PollConditionOptions): Promise<void> {
  const { deadline, negated } = options;
  const startedAt = Date.now();
  const grace = Math.min(NEGATION_GRACE_MS, deadline.remaining(startedAt));
  let readAt = startedAt;
  let holdingSince: number | undefined;
  const holds = (now: number): boolean => holdingSince !== undefined && now - holdingSince >= grace;
  let sampled = false;
  for (;;) {
    const startedWithMs = deadline.remaining(readAt);
    let value: boolean | undefined;
    try {
      value = await options.evaluate();
      sampled = true;
    } catch (cause) {
      if (!sampled || !cutOffAtDeadline(cause, startedWithMs)) throw cause;
      if (negated && holds(Math.min(Date.now(), deadline.endsAt))) return;
      throw await options.onTimeout(cause);
    }
    if (!negated) {
      if (value === true) return;
    } else {
      holdingSince = value === false ? (holdingSince ?? readAt) : undefined;
    }
    const now = Date.now();
    if (holds(now)) return;
    if (deadline.expired(now)) throw await options.onTimeout();
    await sleep(negated ? Math.min(POLL_INTERVAL_MS, deadline.remaining(now)) : POLL_INTERVAL_MS, options.signal);
    readAt = Date.now();
    if (negated && deadline.expired(readAt)) {
      if (holds(readAt)) return;
      throw await options.onTimeout();
    }
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
