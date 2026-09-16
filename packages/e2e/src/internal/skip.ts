/**
 * Skipping a running test from its body: `test.skip(condition, reason)`.
 *
 * The signal is not an `E2EError`: a skip is a verdict, not a failure, and it
 * must never be classified, retried, or reported as one. The attempt runner
 * recognizes it by brand, not by class, because a test module loads in its
 * own realm and may resolve `e2e` to another copy of this package (the built
 * `dist` next to a runner on `src`, or a nested install).
 */

import { currentAttempt } from '../expect/attempt.ts';
import { CollectionError, TestError } from './errors.ts';

const runtimeSkipBrand: unique symbol = Symbol.for('e2e.runtimeSkip.v1');

export class RuntimeSkip {
  readonly [runtimeSkipBrand] = true as const;
  readonly reason: string;

  constructor(reason: string | undefined) {
    this.reason = reason === undefined || reason.trim() === '' ? 'skipped' : reason;
  }
}

export function isRuntimeSkip(value: unknown): value is RuntimeSkip {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [runtimeSkipBrand]?: unknown })[runtimeSkipBrand] === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}

/** The three shapes `test.skip` accepts, told apart before anything runs. */
export type SkipCall =
  | { readonly kind: 'register'; readonly title: string; readonly fn: unknown }
  | { readonly kind: 'runtime'; readonly condition: boolean; readonly reason: string | undefined };

/**
 * `skip(title, fn)` registers a skipped test; `skip(condition, reason?)` and
 * `skip(reason?)` skip the running one. A string alone is a reason, never a
 * title: a registration always carries its body.
 */
export function parseSkipCall(first: unknown, second: unknown): SkipCall {
  if (typeof first === 'string' && typeof second === 'function') return { kind: 'register', title: first, fn: second };
  return {
    kind: 'runtime',
    condition: typeof first === 'boolean' ? first : true,
    reason: typeof first === 'string' ? first : typeof second === 'string' ? second : undefined,
  };
}

/**
 * Skips the running test when `condition` holds. Outside a body there is no
 * running test, so the call is a collection error pointing at the `skip`
 * option; inside a setup test it is a test error, because the sessions the
 * setup declares are owed to their consumers.
 */
export function skipRunningTest(condition: boolean, reason: string | undefined): void {
  const attempt = currentAttempt();
  if (attempt === undefined) {
    throw new CollectionError(
      'test.skip(condition, reason) skips the running test and must be called inside a test body; to skip at collection, pass { skip: true } or a reason string as the test option',
    );
  }
  if (!condition) return;
  if (attempt.testKind === 'setup') {
    throw new TestError('INVALID_ARGUMENT', 'test.skip() cannot skip a setup test: the sessions it declares are owed to their consumers');
  }
  throw new RuntimeSkip(reason);
}
