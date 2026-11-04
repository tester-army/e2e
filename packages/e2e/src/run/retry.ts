/** Shared retry policy for ordinary tests, setup tests, and serial groups. */

import type { SerializedError } from '../internal/errors.ts';
import type { RetryOnCategory } from '../types.ts';
import type { AttemptStatus, ResultStatus, SerialAttemptRecord } from './records.ts';

/**
 * Whether a retry's member records are not the verdict. True when the retry
 * was interrupted, including after members ran (`reachedMembers` true), or
 * when it never reached its members.
 */
export function isCutSerialRetry(status: SerialAttemptRecord['status'], index: number, reachedMembers: boolean): boolean {
  return index > 0 && (status === 'interrupted' || !reachedMembers);
}

/** The categories `retryOn` accepts, for config validation. */
export const RETRY_ON_CATEGORIES: readonly RetryOnCategory[] = ['test', 'infrastructure'];

/** The budget's default spender when the config does not say otherwise. */
export const DEFAULT_RETRY_ON: readonly RetryOnCategory[] = ['test'];

/** The status-and-error slice of an attempt the retry policy inspects. */
export interface RetryAttempt {
  readonly status: AttemptStatus;
  readonly error?: SerializedError | undefined;
}

/**
 * Whether the attempt's failure consumes retry budget: timeouts always do,
 * and a failed attempt does when `retryOn` names its error's category
 * (`test` only by default; `config.retryOn` may add `infrastructure`).
 */
export function isRetryEligible(attempt: RetryAttempt, retryOn: readonly RetryOnCategory[]): boolean {
  if (attempt.status === 'timed-out') return true;
  const category = attempt.error?.category;
  if (category !== 'test' && category !== 'infrastructure') return false;
  return retryOn.includes(category);
}

/**
 * Runs up to `maxAttempts` attempts, stopping on pass, interrupt, or a
 * failure that does not consume retry budget. `runOnce` returns the
 * finished attempt, or undefined when the attempt could not start (the
 * loop stops and the last observed status stands). An interrupt during a
 * retry keeps the verdict the failed attempt before it reached: the test
 * did fail, and only its second chance was cut short. `retryOn` names
 * whose failures spend the budget; omitted, only `test` failures do (and
 * timeouts, which always do).
 */
export async function runWithRetries(
  maxAttempts: number,
  interruptSignal: AbortSignal,
  runOnce: (attemptIndex: number) => Promise<RetryAttempt | undefined>,
  retryOn: readonly RetryOnCategory[],
): Promise<ResultStatus> {
  const attempts: RetryAttempt[] = [];
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (interruptSignal.aborted) break;
    const attempt = await runOnce(attemptIndex);
    if (attempt === undefined) break;
    attempts.push(attempt);
    // A body that skipped itself has decided; a retry would only ask again.
    if (attempt.status === 'passed' || attempt.status === 'interrupted' || attempt.status === 'skipped') break;
    if (!isRetryEligible(attempt, retryOn)) break;
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
