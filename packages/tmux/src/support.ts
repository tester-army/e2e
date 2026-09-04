/** Shared helpers for the tmux backend: error constructors, abort-aware sleeps, cleanup budgets, slugs. */

import { BackendError } from '@e2edev/e2e/backend';

export function cancelled(text: string): BackendError {
  return new BackendError('CANCELLED', text, { retryable: false });
}

export function invalidState(text: string): BackendError {
  return new BackendError('INVALID_STATE', text, { retryable: false });
}

export function notActionable(text: string): BackendError {
  return new BackendError('NOT_ACTIONABLE', text, { retryable: false });
}

export function unsupported(text: string): BackendError {
  return new BackendError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

export function failure(text: string, cause?: unknown): BackendError {
  return new BackendError('BACKEND_FAILURE', text, { retryable: false, ...(cause === undefined ? {} : { cause }) });
}

/** Resolves after `ms`, or rejects with `CANCELLED` the moment `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal, label = 'wait'): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled(`${label} cancelled`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled(`${label} cancelled`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Best-effort cleanup wait: resolves when `promise` settles, when `signal`
 * aborts, or when `timeoutMs` elapses, whichever comes first. Cleanup never
 * throws through here; a kill that outlives its budget is abandoned.
 */
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
  });
}

/** Lower-cased `[a-z0-9.-]` form of a name, for socket names and path anchors. */
export function slug(value: string): string {
  return (
    value
      .replaceAll(/[^A-Za-z0-9.-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .toLowerCase() || 'unknown'
  );
}

/**
 * The location a terminal surface reports through `url`. A terminal has no
 * address bar, but the trace cache anchors every recorded step on a path and
 * refuses to write a trace for a surface without one, so the backend mints
 * one: `app://terminal/<program>/<pane title>`. The cache compares pathnames
 * only, so the program identity lives in the path: two programs whose panes
 * are both titled "Help" must not share an anchor.
 */
export function screenUrl(program: string, title: string): string {
  const trimmed = title.replaceAll(/\s+/g, ' ').trim();
  return `app://terminal/${slug(program)}/${trimmed === '' ? '' : encodeURIComponent(trimmed)}`;
}
