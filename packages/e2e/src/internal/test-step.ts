/**
 * `test.step(title, body)`: one named grouping step on the running attempt.
 *
 * The step runs nothing of its own. Its body calls the fixtures as the test
 * body would, and every step those calls open records this one as `parent`.
 * The recorder is reached through the published attempt, the way
 * `expect.poll` and `test.skip` reach theirs: `test` has no fixture argument
 * to carry it on.
 */

import { currentAttempt } from '../expect/attempt.ts';
import { CollectionError, TestError } from './errors.ts';
import { validateTitle } from './ids.ts';

/**
 * Runs `body` as a `test.step` step of the running attempt and resolves with
 * its result. Outside a running test there is no attempt to record on, so
 * the call is a collection error, like `test.skip(condition)` outside a body.
 * The title follows the same rule as a test title.
 */
export function runTestStep<T>(title: string, body: () => T | Promise<T>): Promise<T> {
  const attempt = currentAttempt();
  if (attempt === undefined) {
    throw new CollectionError(
      'test.step(title, body) groups the steps of a running test and must be called inside a test body or a beforeEach/afterEach hook',
    );
  }
  const titleError = typeof title === 'string' ? validateTitle(title) : 'title must be a string';
  if (titleError !== null) throw new TestError('INVALID_ARGUMENT', `test.step() ${titleError}`);
  if (typeof body !== 'function') {
    throw new TestError('INVALID_ARGUMENT', `test.step(${JSON.stringify(title)}) body must be a function`);
  }
  return attempt.steps.run('test', 'test.step', title, async () => body());
}
