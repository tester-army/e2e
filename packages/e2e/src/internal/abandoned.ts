/** Work a test left running when its phase returned: steps and polls nobody awaited. */

/** What abandoned work rejected with. The promise the test holds rejects with the same value, and nobody awaits it. */
const ABANDONED_REJECTIONS = new WeakSet<object>();

/** Records `cause` as the rejection of work already failed as not awaited. */
export function markAbandonedRejection(cause: unknown): void {
  if (typeof cause === 'object' && cause !== null) ABANDONED_REJECTIONS.add(cause);
}

/**
 * Whether an unhandled rejection is abandoned work's: already recorded as
 * `STEP_NOT_AWAITED`, reaching the process only because the promise the
 * test did not await rejected with it. Such a rejection is not a fault.
 */
export function isAbandonedRejection(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && ABANDONED_REJECTIONS.has(cause);
}

/** Points `error` at the frames of `stack`, keeping its own name and message as the first line. */
export function relocateStack(error: Error, stack: string | undefined): void {
  if (stack === undefined) return;
  const frames = stack.split('\n').slice(1).join('\n');
  error.stack = `${error.name}: ${error.message}\n${frames}`;
}
