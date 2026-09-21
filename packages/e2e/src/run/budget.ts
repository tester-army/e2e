/** The cancellation signal and deadline an attempt's fixtures run under, per phase. */

import { Deadline } from '../internal/time.ts';

/**
 * One attempt's fixture budget. Through `beforeEach` and the body it is the
 * attempt signal and the test deadline. Each `afterEach` hook, `cleanup`
 * callback, and fixture teardown then enters a budget of its own (every
 * teardown has a separate `cleanupTimeout`), so
 * teardown can still drive the app after the body timed
 * out or was cancelled, and a hook that overruns is cancelled without taking
 * the next hook's budget with it. Fixtures read the budget at call time, so a
 * fixture acquired in the body keeps working in teardown.
 */
export class AttemptBudget {
  private current: { readonly signal: AbortSignal; readonly deadline: Deadline };

  constructor(signal: AbortSignal, deadline: Deadline) {
    this.current = { signal, deadline };
  }

  /** The signal the running phase's operations abort with. */
  get signal(): AbortSignal {
    return this.current.signal;
  }

  /** The deadline the running phase's operations are capped by. */
  get deadline(): Deadline {
    return this.current.deadline;
  }

  /**
   * Switches to a fresh budget of `timeoutMs` that also follows `parent`.
   * Aborting the returned controller cancels only this budget's operations.
   */
  enter(parent: AbortSignal, timeoutMs: number): AbortController {
    const controller = new AbortController();
    this.current = {
      signal: AbortSignal.any([parent, controller.signal]),
      deadline: new Deadline(timeoutMs),
    };
    return controller;
  }
}
