/**
 * The engine's errors in one place: the constructors it fails with, the
 * protocol and page errors its driver sees, how a failure is classified
 * onto the engine error contract, the latch for failures no step awaits,
 * and the one place an error is dropped on purpose.
 */

import { ConfigurationError, EngineError, InfrastructureError, TestError, withinCleanupBudget, type EngineCleanupContext } from 'e2e/engine';

/** Browser call logs may carry color codes; escape codes are noise in reports. */
// oxlint-disable-next-line no-control-regex -- intentionally matches the ESC control character
const ANSI_PATTERN = /\u001b\[\d+(?:;\d+)*m/g;

/** A failure's message with terminal control sequences removed. */
export function message(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(ANSI_PATTERN, '');
}

/** An operation the engine's state rules out now. */
export function invalidState(text: string): EngineError {
  return new EngineError('INVALID_STATE', text, { retryable: false });
}

/** Work given up on because its caller cancelled it or no longer wants it. */
export function cancelled(text: string, cause?: unknown): EngineError {
  return new EngineError('CANCELLED', text, { retryable: false, ...(cause === undefined ? {} : { cause }) });
}

/** The error `signal` aborted with when it is an engine-owned deadline, else a plain cancellation of `label`. */
export function abortError(signal: AbortSignal, label: string): EngineError {
  return signal.reason instanceof EngineError && signal.reason.code === 'OPERATION_TIMEOUT' ? signal.reason : cancelled(`${label} cancelled`);
}

/** A BiDi error response, with the protocol's error code kept for classification. */
export class BidiError extends Error {
  constructor(
    readonly method: string,
    readonly error: string,
    /** The browser's own words, apart from the method and code. */
    readonly detail: string,
  ) {
    super(`${method}: ${error}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'BidiError';
  }
}

/** A page function that threw; its message is the page's own. */
export class ScriptError extends Error {
  constructor(text: string) {
    super(text);
    this.name = 'ScriptError';
  }
}

/**
 * The runner error classes as their `name` reads. A project can load this
 * engine against a copy of `e2e` other than the one the runner's core runs
 * from (and e2e before 0.17 always loaded config in a module realm of its
 * own), so a runner error reaching the engine can be a `TestError` this
 * module never imported: `instanceof` says no while `name` and `code` still
 * tell the truth.
 */
const CLASSIFIED_NAMES: ReadonlySet<string> = new Set([
  'EngineError',
  'TestError',
  'ConfigurationError',
  'InfrastructureError',
]);

/**
 * True for an error that already carries its classification: an `EngineError`
 * or a runner error (policy, validation, timeout) from any module copy. Those
 * must cross the boundary untouched; re-wrapping one would turn a
 * `POLICY_DENIED` into an infrastructure failure.
 */
export function isClassified(cause: unknown): cause is Error {
  if (cause instanceof EngineError || cause instanceof TestError) return true;
  if (cause instanceof ConfigurationError || cause instanceof InfrastructureError) return true;
  return cause instanceof Error && CLASSIFIED_NAMES.has(cause.name);
}

/**
 * True for a `TestError` carrying `code`, from this module copy or another.
 * A matcher that reads a node it may be early for asks this before deciding
 * whether the miss is one more poll or the assertion's failure.
 */
export function isTestErrorCode(cause: unknown, code: string): cause is Error & { readonly code: string } {
  return cause instanceof Error && cause.name === 'TestError' && (cause as { code?: unknown }).code === code;
}

/**
 * BiDi codes and browser words that mean the element, frame, or document is
 * gone. `does not belong to the document` is CDP's word for a node of the
 * document a navigation just replaced, which `chromium-bidi` passes on as
 * `unknown error` until it learns the new document.
 */
const STALE_PATTERN = /no such node|no such frame|stale element|no such element|detached|execution context was destroyed|cannot find context|context with specified id|document unloaded|target navigated or closed|does not belong to the document/i;

/** What a failure says about itself, the BiDi method name left out: a navigation command's failure is no stale node. */
function ownWords(cause: unknown): string | undefined {
  if (cause instanceof BidiError) return `${cause.error} ${cause.detail}`;
  if (cause instanceof ScriptError) return cause.message;
  return undefined;
}

/**
 * Maps a failure onto the engine error contract: classified errors pass, a
 * gone node or document is retryable `NODE_STALE`. Not for a call that runs
 * the test's own code (`testCode`): repeating it would run that code again,
 * so a document gone under it is an engine fault.
 */
export function classify(cause: unknown, label: string, testCode = false): Error {
  if (isClassified(cause)) return cause;
  const text = message(cause);
  if (!testCode && STALE_PATTERN.test(ownWords(cause) ?? '')) {
    return new EngineError('NODE_STALE', `${label}: ${text}`, { retryable: true, cause });
  }
  return new EngineError('ENGINE_FAILURE', `${label}: ${text}`, { retryable: false, cause });
}

/** Codes a failure after input went out can carry while the input may have reached the app. */
const UNCERTAIN = new Set(['OPERATION_TIMEOUT', 'NODE_STALE', 'ENGINE_FAILURE', 'CANCELLED']);

/**
 * A classified failure of an input operation: once its input was dispatched,
 * a timeout, a gone node, or a fault leaves it uncertain whether the app
 * took it (`ACTION_MAY_HAVE_COMMITTED`, never retried blindly). A sensitive
 * fill's value is scrubbed from the message and its cause dropped, so the
 * plaintext never leaves the engine.
 */
export function afterDispatch(error: Error, label: string, dispatched: boolean, sensitive?: string): Error {
  const code = error instanceof EngineError || error instanceof TestError ? error.code : undefined;
  const scrub = (text: string): string => (sensitive === undefined || sensitive === '' ? text : text.replaceAll(sensitive, '[redacted]'));
  if (dispatched && code !== undefined && UNCERTAIN.has(code)) {
    return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label} failed after its input was dispatched: ${scrub(error.message)}`, {
      retryable: false,
      ...(sensitive === undefined ? { cause: error } : {}),
    });
  }
  if (sensitive === undefined || error.message.indexOf(sensitive) === -1) return sensitive === undefined ? error : withoutCause(error);
  return new EngineError(error instanceof EngineError ? error.code : 'ENGINE_FAILURE', scrub(error.message), { retryable: false });
}

/** A sensitive fill's error without the raw cause, whose stack a report would print. */
function withoutCause(error: Error): Error {
  if (!(error instanceof EngineError) || error.cause === undefined) return error;
  return new EngineError(error.code, error.message, { retryable: error.retryable });
}

/** Whether `cause` classifies as a gone node or document. */
export function isStale(cause: unknown): boolean {
  const error = classify(cause, '');
  return error instanceof EngineError && error.code === 'NODE_STALE';
}

/** `work`'s result, or `fallback` when the node or document it read is gone; any other failure propagates. */
export async function unlessStale<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    if (isStale(cause)) return fallback;
    throw cause;
  }
}

/**
 * Runs cleanup whose failure changes nothing for the caller: releasing a
 * subscription, intercept, collector, or preload script that the browser
 * drops with its context or session anyway. Never for work whose outcome
 * the caller reads.
 */
export async function releaseQuietly(work: Promise<unknown> | undefined): Promise<void> {
  try {
    await work;
  } catch {
    return;
  }
}

/**
 * Holds one error raised on a path nobody awaits - a native dialog nobody
 * handled, a route handler that broke its contract - until the next step
 * enters the surface, which then fails with the real cause, or until the
 * attempt settles when no step follows. Rethrows once: the failure belongs
 * to the step that observes it, not to every later one.
 */
export class ErrorLatch {
  private pending: Error | null = null;
  private readonly running = new Map<Promise<void>, string>();
  private abandoned = false;

  /** Latches an error; the first one wins until it is thrown. Dropped once `settle` gave up on a handler. */
  latch(error: Error): void {
    if (this.abandoned) return;
    this.pending ??= error;
  }

  /** Tracks one unawaited `kind` of path (a route or dialog handler) until it settles, so `settle` can wait for it. Its own rejection is the caller's to latch. */
  track(kind: string, work: Promise<void>): void {
    const tracked: Promise<void> = work.then(() => undefined, () => undefined);
    this.running.set(tracked, kind);
    void tracked.then(() => this.running.delete(tracked));
  }

  /**
   * Rethrows the latched error once; with none latched yet, first waits,
   * within the budget, for the tracked paths running when it was called. One
   * of those that outlives the budget fails closed: `CLEANUP_TIMEOUT` naming
   * it, and whatever it throws afterwards is dropped here on purpose rather
   * than landing on a verdict already reached. A path that starts during the
   * wait is left to the next settle.
   */
  async settle(budget: EngineCleanupContext): Promise<void> {
    this.throwPending();
    if (!this.abandoned && this.running.size > 0) {
      const waited = [...this.running.keys()];
      await withinCleanupBudget(Promise.all(waited), budget);
      const outlived = waited.filter((path) => this.running.has(path));
      if (outlived.length > 0) {
        const kinds = [...new Set(outlived.map((path) => this.running.get(path)))].toSorted().join(' and ');
        this.running.clear();
        this.abandoned = true;
        this.throwPending();
        throw new InfrastructureError(
          'CLEANUP_TIMEOUT',
          `a ${kinds} handler was still running when the cleanup budget ended; anything it throws now is dropped`,
        );
      }
    }
    this.throwPending();
  }

  /** Rethrows the latched error once, if any. */
  throwPending(): void {
    if (this.pending !== null) {
      const error = this.pending;
      this.pending = null;
      throw error;
    }
  }
}
