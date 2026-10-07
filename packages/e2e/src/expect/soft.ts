/** expect.soft: matcher failures kept for the end of the body instead of thrown. */

import { classifyError, E2EError, TestError } from '../internal/errors.ts';
import { currentAttempt } from './attempt.ts';

/**
 * The soft failures of one attempt. The runner opens one per attempt and
 * closes it when the body settles; a failure kept while it is open fails the
 * attempt then, all of them in one error. Closed, it keeps nothing, and the
 * matcher throws as a hard `expect` would.
 */
export class SoftFailures {
  private readonly failures: E2EError[] = [];
  private open = true;
  private readonly lastVerified: () => number;
  private verifiedAtFirst: number | undefined;

  /** `lastVerified` reads the attempt's highest passed verification step index (`StepRecorder.lastVerifiedStepIndex`). */
  constructor(lastVerified: () => number) {
    this.lastVerified = lastVerified;
  }

  /**
   * The highest verified step index when the first failure was kept, or
   * undefined when none was. The attempt fails where that failure landed, not
   * where the body settled: a check that passed after it confirms no replay
   * cache entry the failed one may have been about.
   */
  get verifiedBeforeFirstFailure(): number | undefined {
    return this.verifiedAtFirst;
  }

  /** Keeps `error` for the verdict; false once the body has settled, when the caller must throw it instead. */
  keep(error: E2EError): boolean {
    if (!this.open) return false;
    this.verifiedAtFirst ??= this.lastVerified();
    this.failures.push(error);
    return true;
  }

  /**
   * Ends collection and returns the one error for everything kept, or nothing
   * when every soft matcher passed. The error unwinds through the first
   * failure's stack, so the report points at the first `expect.soft` line.
   * Hands out each failure once: a second close, after a body that timed out
   * or was interrupted, returns nothing.
   */
  close(): TestError | undefined {
    this.open = false;
    const failures = this.failures.splice(0);
    const [first] = failures;
    if (first === undefined) return undefined;
    const count = failures.length;
    const lines = [
      `${count} soft assertion${count === 1 ? '' : 's'} failed`,
      ...failures.map((failure, i) => `${i + 1}. ${failure.message.split('\n').join('\n   ')}`),
    ];
    const error = new TestError('ASSERTION_FAILED', lines.join('\n'));
    const stack = (first.cause instanceof Error ? first.cause.stack : undefined) ?? first.stack;
    if (stack !== undefined) {
      error.stack = `${error.name}: ${error.message}\n${stack.split('\n').slice(1).join('\n')}`;
    }
    return error;
  }
}

/**
 * Keeps an assertion failure on the running attempt, or rethrows it when
 * nothing is collecting. An engine fixture's matcher throws from its own copy
 * of the error module, so the failure is classified rather than checked with
 * `instanceof`.
 */
function keepOrThrow(error: unknown): void {
  const classified = classifyError(error);
  if (classified.code !== 'ASSERTION_FAILED' || currentAttempt()?.soft.keep(classified) !== true) throw error;
}

/**
 * Every matcher of `expectation` with its `ASSERTION_FAILED` swallowed into
 * the running attempt's soft failures. `.not` softens the same way. Methods
 * run against the real expectation, so nothing about how it is built matters
 * here: the value matchers, the locator matchers, and an engine fixture's
 * attached matchers all go through the one wrapper.
 */
export function soften<E extends object>(expectation: E): E {
  return new Proxy(expectation, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === 'not' && typeof value === 'object' && value !== null) return soften(value);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        let result: unknown;
        try {
          result = (value as (...args: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          keepOrThrow(error);
          return undefined;
        }
        if (result instanceof Promise) return result.catch(keepOrThrow);
        return result;
      };
    },
  });
}
