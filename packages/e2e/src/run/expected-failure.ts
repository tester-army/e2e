/**
 * The verdict of an attempt marked `test.fail`. A marked attempt that fails
 * with a product failure passes, keeping the error beside the reason; one
 * that passes fails with `UNEXPECTED_PASS`. Nothing else is covered: an
 * infrastructure, configuration, or internal error, an interrupt, a blocked
 * agent verdict, a suite hook failure, or a test that misuses the API says
 * nothing about the app, and hiding it would hide a crashed browser, a broken
 * run, or a broken test.
 */

import { BLOCKABLE_CODES } from '../agent/executor.ts';
import { sanitizeText, TestError, truncateUtf8, type ErrorPhase, type SerializedError } from '../internal/errors.ts';
import type { ExpectedFailureInfo } from '../internal/expected-failure.ts';
import type { AgentErrorCode } from '../types.ts';
import type { AttemptStatus } from './records.ts';

/** The report schema's bound on a reason. */
const MAX_REASON_BYTES = 8192;

/** Test-category codes that say the test is broken, not the app. */
const AUTHORING_CODES: ReadonlySet<string> = new Set([
  'INVALID_ARGUMENT',
  'INVALID_LOCATOR',
  'UNSUPPORTED_CAPABILITY',
  'STEP_NOT_AWAITED',
  'UNEXPECTED_PASS',
]);

/** Phases that belong to the suite, not to the marked test. */
const SUITE_PHASES: ReadonlySet<ErrorPhase | undefined> = new Set(['beforeAll', 'afterAll']);

/** The verdict-bearing slice of an attempt record. */
interface MarkableAttempt {
  status: AttemptStatus;
  error?: SerializedError;
  skip?: unknown;
  readonly secondaryErrors: readonly SerializedError[];
  expectedFailure?: ExpectedFailureInfo;
}

/** How the attempt's errors and reason are made safe for the report. */
export interface ExpectedFailureSerializer {
  readonly serialize: (error: TestError) => SerializedError;
  readonly redact: (text: string) => string;
}

/** Whether an error is a product failure of the test itself: test-category, not blocked, not an authoring error, not a suite hook. */
function isProductFailure(error: SerializedError): boolean {
  return (
    error.category === 'test' &&
    !BLOCKABLE_CODES.has(error.code as AgentErrorCode) &&
    !AUTHORING_CODES.has(error.code) &&
    !SUITE_PHASES.has(error.phase)
  );
}

/**
 * Applies a mark to a finished attempt once its status is classified, before
 * its recordings are kept or dropped, so they follow the verdict. A skip wins
 * and drops the mark, also beside a failure. A pass becomes
 * `UNEXPECTED_PASS`. A product failure or timeout becomes a pass, its error
 * moved into `expectedFailure`, unless an error that is not one landed beside
 * it outside cleanup. Anything else keeps its verdict and records the mark.
 */
export function settleExpectedFailure(record: MarkableAttempt, mark: string | undefined, { serialize, redact }: ExpectedFailureSerializer): void {
  if (mark === undefined || record.status === 'skipped' || record.skip !== undefined) return;
  const reason = truncateUtf8(sanitizeText(redact(mark)), MAX_REASON_BYTES);
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
