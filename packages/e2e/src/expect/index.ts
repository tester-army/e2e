/** Public expect() dispatcher (spec api/e2e.d.ts). */

import type { AsyncExpectation, Expect, Expectable, Locator, ValueExpectation } from '../types.ts';
import { expectationBrand } from '../internal/brands.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { locatorInternals } from '../locator/screen.ts';
import { createAsyncExpectation } from './async.ts';
import { createPollExpectation } from './poll.ts';
import { createValueExpectation } from './values.ts';

/**
 * A fixture's attached expectation surface hangs off the fixture object under
 * a global symbol (`EngineFixtureContext.expectable`), so an expect()
 * imported in an isolated test-module realm can still reach it. Core routes
 * to the surface and never knows which matchers a platform contributed.
 */
const expectationSlot = realmSlot<object>(expectationBrand);

function dispatch(actual: Locator): AsyncExpectation;
function dispatch<E extends object>(actual: Expectable<E>): E;
function dispatch<T>(actual: T, message?: string): ValueExpectation<T>;
function dispatch(actual: unknown, message?: string): AsyncExpectation | object | ValueExpectation<unknown> {
  const internals = locatorInternals(actual);
  if (internals !== undefined) return createAsyncExpectation(internals);
  const attached = expectationSlot.get(actual);
  if (attached !== undefined) return attached;
  return createValueExpectation(actual, message);
}

/**
 * Creates deterministic or async e2e expectations. `expect.poll(read)` is the
 * asynchronous form of the value matchers, for state the app writes after a
 * step has already returned.
 */
export const expect: Expect = Object.assign(dispatch, { poll: createPollExpectation });
