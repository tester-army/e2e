/**
 * The verdict of an attempt marked `test.fail`. A marked attempt that fails
 * with a product failure passes, keeping the error beside the reason; one
 * that passes fails with `UNEXPECTED_PASS`. Nothing else is covered: an
 * infrastructure, configuration, or internal error, an interrupt, or a
 * blocked agent verdict says nothing about the app, and hiding it would hide
 * a crashed browser or a broken run.
 */

import { BLOCKABLE_CODES } from '../agent/executor.ts';
import { TestError, type SerializedError } from '../internal/errors.ts';
import type { ExpectedFailureInfo } from '../internal/expected-failure.ts';
import type { AgentErrorCode } from '../types.ts';
import type { AttemptStatus } from './records.ts';

/** The verdict-bearing slice of an attempt record. */
interface MarkableAttempt {
  status: AttemptStatus;
  error?: SerializedError;
  skip?: unknown;
  readonly secondaryErrors: readonly SerializedError[];
  expectedFailure?: ExpectedFailureInfo;
}

/** Whether an error is a product failure: a test-category error with no blocked reading. */
function isProductFailure(error: SerializedError): boolean {
  return error.category === 'test' && !BLOCKABLE_CODES.has(error.code as AgentErrorCode);
}

/**
 * Applies a mark to a finished attempt, once nothing else will change its
 * verdict. A skip wins and drops the mark, also beside a failure. A pass
 * becomes `UNEXPECTED_PASS`. A product failure or timeout becomes a pass,
 * its error moved into `expectedFailure`, unless an error that is not one
 * landed beside it outside cleanup. Anything else keeps its verdict and
 * records the mark.
 */
export function settleExpectedFailure(
  record: MarkableAttempt,
  reason: string | undefined,
  serialize: (error: TestError) => SerializedError,
): void {
  if (reason === undefined || record.status === 'skipped' || record.skip !== undefined) return;
  if (record.status === 'passed') {
    record.status = 'failed';
    record.error = serialize(
      new TestError('UNEXPECTED_PASS', `test is marked test.fail (${JSON.stringify(reason)}) but passed; remove the mark if it is fixed`),
    );
    record.expectedFailure = { reason };
    return;
  }
  const error = record.error;
  const covered =
    (record.status === 'failed' || record.status === 'timed-out') &&
    error !== undefined &&
    isProductFailure(error) &&
    record.secondaryErrors.every((secondary) => secondary.phase === 'cleanup' || isProductFailure(secondary));
  if (covered) {
    record.status = 'passed';
    delete record.error;
    record.expectedFailure = { reason, error };
    return;
  }
  record.expectedFailure = { reason };
}
