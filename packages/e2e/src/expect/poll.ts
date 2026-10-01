/** expect.poll: re-reads a value until a synchronous matcher passes. */

import { ConfigurationError, E2EError, TestError } from '../internal/errors.ts';
import { Deadline, POLL_INTERVAL_MS, sleep, withAbort, withTimeout } from '../internal/time.ts';
import type { PollExpectation, PollOptions, ValueExpectation, ValueMatcherName } from '../types.ts';
import { currentAttempt } from './attempt.ts';
import { currentPollScope } from './poll-scope.ts';
import { createValueExpectation } from './values.ts';

/** Outside an attempt (a standalone script) there is no config to read `assertionTimeout` from. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Frames kept for the line a poll was called on; the user's line is a few frames up. */
const CALL_STACK_FRAMES = 20;

/** `satisfies` keeps this list equal to the ValueExpectation matcher set. */
const MATCHERS = {
  toBe: true,
  toEqual: true,
  toMatchObject: true,
  toBeTruthy: true,
  toBeFalsy: true,
  toBeNull: true,
  toBeUndefined: true,
  toBeDefined: true,
  toHaveLength: true,
  toHaveProperty: true,
  toContain: true,
  toMatch: true,
  toBeGreaterThan: true,
  toBeGreaterThanOrEqual: true,
  toBeLessThan: true,
  toBeLessThanOrEqual: true,
  toBeCloseTo: true,
  toMatchSchema: true,
} satisfies Record<ValueMatcherName, true>;

type Matcher = (this: ValueExpectation<unknown>, ...args: unknown[]) => unknown;

/** A read that outlived the deadline, as opposed to one that failed. */
class ReadHung extends Error {}

/** The attempt ended while a read was in flight. */
class ReadAborted extends Error {}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotYet(error: unknown): boolean {
  return error instanceof E2EError && error.code === 'ASSERTION_FAILED';
}

function cancelled(): E2EError {
  return new E2EError('infrastructure', 'CANCELLED', 'operation cancelled');
}

/** One read, cut at the deadline and at the attempt signal; a hung read's outcome is dropped. */
function sample(
  read: () => unknown,
  deadline: Deadline,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const bounded = withTimeout((async () => read())(), deadline.remaining(), () => new ReadHung());
  return signal === undefined ? bounded : withAbort(bounded, signal, () => new ReadAborted());
}

/** The stack at a poll's call, for the error that names it when its phase did not await it. */
function callStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = CALL_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

function matcherLabel(negated: boolean, name: ValueMatcherName): string {
  return `expect.poll(...).${negated ? 'not.' : ''}${name}(...)`;
}

async function pollMatcher(
  read: () => unknown,
  options: PollOptions,
  negated: boolean,
  name: ValueMatcherName,
  args: unknown[],
  scopeSignal: AbortSignal | undefined,
): Promise<unknown> {
  const attempt = currentAttempt();
  const timeout = options.timeout ?? attempt?.assertionTimeout ?? DEFAULT_TIMEOUT_MS;
  const interval = options.interval ?? POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const own = new Deadline(timeout, startedAt);
  // Inside an attempt the poll ends with the phase it runs in (the test
  // deadline in the body, the hook's cleanup budget in afterEach) and stops
  // the moment the attempt is cancelled, so a timed-out test never keeps
  // reading through teardown.
  const deadline = attempt === undefined ? own : Deadline.min(own, attempt.budget.deadline);
  // The phase that started the poll cancels it when it returns without
  // awaiting it, so the poll can never fail whatever runs after.
  const signals = [attempt?.budget.signal, scopeSignal].filter((signal) => signal !== undefined);
  const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
  let last: string | undefined;
  while (!deadline.expired()) {
    if (signal?.aborted === true) throw cancelled();
    let value: unknown;
    try {
      value = await sample(read, deadline, signal);
    } catch (error) {
      if (error instanceof ReadHung) break;
      if (error instanceof ReadAborted) throw cancelled();
      last = describeError(error);
      await sleep(Math.min(interval, deadline.remaining()), signal);
      continue;
    }
    const expectation = createValueExpectation(value);
    const target = negated ? expectation.not : expectation;
    try {
      return (target[name] as Matcher).apply(target, args);
    } catch (error) {
      if (!isNotYet(error)) throw error;
      last = describeError(error);
    }
    await sleep(Math.min(interval, deadline.remaining()), signal);
  }
  const ending =
    deadline === own
      ? `timed out after ${timeout} ms`
      : `stopped at the attempt deadline after ${Date.now() - startedAt} ms`;
  throw new TestError(
    'ASSERTION_FAILED',
    [
      `${matcherLabel(negated, name)} ${ending}`,
      ...(options.message === undefined ? [] : [options.message]),
      `last: ${last ?? 'no read completed'}`,
    ].join('\n'),
  );
}

/** A malformed option would poll forever; it is refused before the first read. */
function checkOptions(options: PollOptions): void {
  const { timeout, interval } = options;
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout >= 0)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `expect.poll timeout must be a finite number of milliseconds, 0 or more; got ${String(timeout)}`,
    );
  }
  if (interval !== undefined && !(Number.isFinite(interval) && interval > 0)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `expect.poll interval must be a finite number of milliseconds above 0; got ${String(interval)}`,
    );
  }
}

function build<T>(
  read: () => T | Promise<T>,
  options: PollOptions,
  negated: boolean,
): PollExpectation<T> {
  const matchers = Object.fromEntries(
    (Object.keys(MATCHERS) as ValueMatcherName[]).map((name) => [
      name,
      (...args: unknown[]) => {
        const scope = currentPollScope();
        if (scope === undefined) return pollMatcher(read, options, negated, name, args, undefined);
        return scope.track(matcherLabel(negated, name), callStack(), (signal) =>
          pollMatcher(read, options, negated, name, args, signal),
        );
      },
    ]),
  );
  return {
    ...matchers,
    get not() {
      return build(read, options, !negated);
    },
  } as PollExpectation<T>;
}

/** Re-reads `read` until the chosen value matcher holds or `options.timeout` passes. */
export function createPollExpectation<T>(
  read: () => T | Promise<T>,
  options: PollOptions = {},
): PollExpectation<T> {
  checkOptions(options);
  return build(read, options, false);
}
