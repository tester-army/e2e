/** Shared retry policy for ordinary tests, setup tests, and serial groups. */

import type { SerializedError } from '../internal/errors.ts';
import type { ResultStatus } from './records.ts';

/** The status-and-error slice of an attempt the retry policy inspects. */
export interface RetryAttempt {
  readonly status: 'passed' | 'failed' | 'timed-out' | 'interrupted';
  readonly error?: SerializedError | undefined;
}

/** Only test-category failures and timeouts consume retry budget. */
export function isRetryEligible(attempt: RetryAttempt): boolean {
  return (
    attempt.status === 'timed-out' ||
    (attempt.error !== undefined && attempt.error.category === 'test')
  );
}

/**
 * Runs up to `maxAttempts` attempts, stopping on pass, interrupt, or a
 * failure that does not consume retry budget. `runOnce` returns the
 * finished attempt, or undefined when the attempt could not start (the
 * loop stops and the last observed status stands).
 */
export async function runWithRetries(
  maxAttempts: number,
  interruptSignal: AbortSignal,
  runOnce: (attemptIndex: number) => Promise<RetryAttempt | undefined>,
): Promise<ResultStatus> {
  let finalStatus: ResultStatus = 'failed';
  let attemptCount = 0;
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (interruptSignal.aborted) break;
    const attempt = await runOnce(attemptIndex);
    if (attempt === undefined) break;
    attemptCount += 1;
    if (attempt.status === 'passed') return attemptCount > 1 ? 'flaky' : 'passed';
    if (attempt.status === 'interrupted') return 'interrupted';
    finalStatus = attempt.status;
    if (!isRetryEligible(attempt)) break;
  }
  return finalStatus;
}
