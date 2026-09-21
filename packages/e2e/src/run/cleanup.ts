/** The `cleanup` fixture: teardown callbacks a test registers, run newest first once it is over. */

import { ConfigurationError, TestError } from '../internal/errors.ts';
import type { Cleanup, CleanupFn } from '../types.ts';

export interface CleanupQueue {
  /** What the test sees as `cleanup`. */
  readonly fixture: Cleanup;
  /**
   * Removes and returns the newest callback, or `undefined` once none is
   * left. A callback registered while the queue drains (from an `afterEach`
   * hook or another callback) is taken on the next call.
   */
  take(): CleanupFn | undefined;
  /** Refuses every later `add`: the attempt's cleanup has run and would miss it. */
  seal(): void;
}

/** Creates the queue behind one attempt's `cleanup` fixture. */
export function createCleanupQueue(): CleanupQueue {
  const callbacks: CleanupFn[] = [];
  let sealed = false;
  return {
    fixture: {
      add(fn) {
        if (typeof fn !== 'function') {
          throw new TestError('INVALID_ARGUMENT', 'cleanup.add() takes a function');
        }
        if (sealed) {
          throw new ConfigurationError(
            'TEST_SETUP_FAILED',
            "cleanup.add() was called after the test's cleanup ran; register callbacks from the body, a hook, or a fixture",
          );
        }
        callbacks.push(fn);
      },
    },
    take: () => callbacks.pop(),
    seal: () => {
      sealed = true;
    },
  };
}
