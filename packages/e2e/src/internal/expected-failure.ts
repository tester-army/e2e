/**
 * Expecting a test to fail: `test.fail(...)` and the `fail` option. The
 * verdict it leads to is `settleExpectedFailure` in `run/expected-failure.ts`.
 */

import { currentAttempt } from '../expect/attempt.ts';
import { CollectionError, TestError, type SerializedError } from './errors.ts';

/** The reason recorded for a mark that gave none. */
const DEFAULT_REASON = 'expected to fail';

/** What the report keeps for an attempt marked expected to fail. */
export interface ExpectedFailureInfo {
  readonly reason: string;
  /** The failure the mark covered; absent when the attempt passed, or failed with an error the mark does not cover. */
  readonly error?: SerializedError;
}

/** A blank or missing reason becomes the default one. */
function expectedFailureReason(reason: string | undefined): string {
  return reason === undefined || reason.trim() === '' ? DEFAULT_REASON : reason;
}

/** The reason a `fail` option gives, or undefined when it marks nothing. */
export function expectedFailureOption(fail: boolean | string | undefined): string | undefined {
  if (fail === undefined || fail === false) return undefined;
  return expectedFailureReason(fail === true ? undefined : fail);
}

/**
 * Marks the running test expected to fail when `condition` holds. Unlike a
 * skip it does not throw: the body runs on. Outside a body there is no
 * running test, so the call is a collection error pointing at the collection
 * forms. A setup test, a serial group member, and a test whose verdict is
 * already reached (its afterEach hooks and fixture teardowns) publish no way
 * to mark, and the call is a test error there.
 */
export function markRunningTestExpectedToFail(condition: boolean, reason: string | undefined): void {
  const attempt = currentAttempt();
  if (attempt === undefined) {
    throw new CollectionError(
      'test.fail(condition, reason) marks the running test and must be called inside a test body; to mark at collection, use test.fail(title, fn) or pass { fail: true } or a reason string as the test option',
    );
  }
  if (!condition) return;
  if (attempt.expectFailure === undefined) {
    throw new TestError('INVALID_ARGUMENT', `test.fail() cannot mark ${unmarkable(attempt)}`);
  }
  attempt.expectFailure(expectedFailureReason(reason));
}

/** Why a test cannot be marked from its teardown. */
const LATE = 'a test from an afterEach hook or a fixture teardown: its verdict is already reached';

/** Why the running attempt cannot be marked. */
function unmarkable(attempt: { readonly owner: 'suite' | 'host'; readonly testKind: 'test' | 'setup' }): string {
  if (attempt.testKind === 'setup') return 'a setup test: the sessions it declares are owed to their consumers';
  if (attempt.owner === 'host') return LATE;
  return 'a serial group member: the group passes or fails as one unit';
}

/** The error for a mark made once the verdict is reached, from an afterEach hook or a fixture teardown. */
export function lateExpectedFailureError(): TestError {
  return new TestError('INVALID_ARGUMENT', `test.fail() cannot mark ${LATE}`);
}
