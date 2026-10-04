/** Shared retry policy for ordinary tests, setup tests, and serial groups. */

import type { SerializedError } from '../internal/errors.ts';
import type { AttemptStatus, ResultStatus } from './records.ts';

/** The status-and-error slice of an attempt the retry policy inspects. */
export interface RetryAttempt {
  readonly status: AttemptStatus;
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
 * loop stops and the last observed status stands). An interrupt during a
 * retry keeps the verdict the failed attempt before it reached: the test
 * did fail, and only its second chance was cut short.
 */
export async function runWithRetries(
  maxAttempts: number,
  interruptSignal: AbortSignal,
  runOnce: (attemptIndex: number) => Promise<RetryAttempt | undefined>,
): Promise<ResultStatus> {
  const attempts: RetryAttempt[] = [];
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (interruptSignal.aborted) break;
    const attempt = await runOnce(attemptIndex);
    if (attempt === undefined) break;
    attempts.push(attempt);
    // A body that skipped itself has decided; a retry would only ask again.
    if (attempt.status === 'passed' || attempt.status === 'interrupted' || attempt.status === 'skipped') break;
    if (!isRetryEligible(attempt)) break;
  }
  return retryVerdict(attempts);
}

/**
 * The verdict a sequence of finished attempts reaches: a pass is `flaky`
 * after a failure, an interrupt during a retry keeps the verdict before it,
 * and a self-skip decides. Also the verdict of attempts a worker finished
 * before the run's interrupt stopped it, so both read alike.
 */
export function retryVerdict(attempts: readonly RetryAttempt[]): ResultStatus {
  let verdict: ResultStatus = 'failed';
  for (const [index, attempt] of attempts.entries()) {
    switch (attempt.status) {
      case 'passed':
        return index > 0 ? 'flaky' : 'passed';
      case 'interrupted':
        return index > 0 ? verdict : 'interrupted';
      case 'skipped':
        return 'skipped';
      default:
        verdict = attempt.status;
    }
  }
  return verdict;
}
