/** Public expect() dispatcher (spec api/e2e.d.ts). */

import { Any, Anything, ArrayContaining, ObjectContaining, StringContaining, StringMatching } from '@vitest/expect';
import type { AsymmetricMatcher, AsyncExpectation, Class, Expect, Expectable, Locator, Screen, ScreenExpectation, SoftValueExpectation, ValueExpectation } from '../types.ts';
import { expectationBrand } from '../internal/brands.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { locatorInternals, screenInternals } from '../locator/screen.ts';
import { createAsyncExpectation } from './async.ts';
import { createPollExpectation } from './poll.ts';
import { createScreenExpectation } from './screenshot.ts';
import { soften } from './soft.ts';
import { createValueExpectation } from './values.ts';

/**
 * A fixture's attached expectation surface hangs off the fixture object under
 * a global symbol (`EngineFixtureContext.expectable`), so an expect()
 * imported in an isolated test-module realm can still reach it. Core routes
 * to the surface and never knows which matchers a platform contributed.
 */
const expectationSlot = realmSlot<object>(expectationBrand);

function dispatch(actual: Locator): AsyncExpectation;
function dispatch(actual: Screen): ScreenExpectation;
function dispatch<E extends object>(actual: Expectable<E>): E;
function dispatch<T>(actual: T, message?: string): ValueExpectation<T>;
function dispatch(actual: unknown, message?: string): AsyncExpectation | ScreenExpectation | object | ValueExpectation<unknown> {
  const internals = locatorInternals(actual);
  if (internals !== undefined) return createAsyncExpectation(internals);
  const attached = expectationSlot.get(actual);
  if (attached !== undefined) return attached;
  const screen = screenInternals(actual);
  if (screen !== undefined) return createScreenExpectation(screen.context, screen.scoped);
  return createValueExpectation(actual, message);
}

function soft(actual: Locator): AsyncExpectation;
function soft(actual: Screen): ScreenExpectation;
function soft<E extends object>(actual: Expectable<E>): E;
function soft<T>(actual: T, message?: string): SoftValueExpectation<T>;
function soft(actual: unknown, message?: string): AsyncExpectation | ScreenExpectation | object | SoftValueExpectation<unknown> {
  return soften(dispatch(actual, message));
}

/**
 * Creates deterministic or async e2e expectations. `expect.poll(read)` is the
 * asynchronous form of the value matchers, for state the app writes after a
 * step has already returned; `expect.soft(actual)` keeps a failure for the
 * end of the body instead of throwing it.
 */
export const expect: Expect = Object.assign(dispatch, {
  poll: createPollExpectation,
  soft,
  // Jest's asymmetric matchers as `@vitest/expect` implements them; its `equals` recognizes one by `asymmetricMatch`.
  any: (sample: Class | typeof BigInt | typeof Symbol): AsymmetricMatcher => new Any(sample),
  anything: (): AsymmetricMatcher => new Anything(),
  objectContaining: (sample: object): AsymmetricMatcher => new ObjectContaining(sample as Record<string, unknown>),
  arrayContaining: (sample: readonly unknown[]): AsymmetricMatcher => new ArrayContaining([...sample]),
  stringContaining: (sample: string): AsymmetricMatcher => new StringContaining(sample),
  stringMatching: (sample: string | RegExp): AsymmetricMatcher => new StringMatching(sample),
});
