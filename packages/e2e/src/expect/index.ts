/** Public expect() dispatcher (spec api/e2e.d.ts). */

import type { AsyncExpectation, Expectable, Locator, ValueExpectation } from '../types.ts';
import { expectationBrand } from '../internal/brands.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { locatorInternals } from '../locator/screen.ts';
import { createAsyncExpectation } from './async.ts';
import { createValueExpectation } from './values.ts';

/**
 * A fixture's attached expectation surface hangs off the fixture object under
 * a global symbol (`EngineFixtureContext.expectable`), so an expect()
 * imported in an isolated test-module realm can still reach it. Core routes
 * to the surface and never knows which matchers a platform contributed.
 */
const expectationSlot = realmSlot<object>(expectationBrand);

/** Creates deterministic or async e2e expectations. */
export function expect(actual: Locator): AsyncExpectation;
export function expect<E extends object>(actual: Expectable<E>): E;
export function expect<T>(actual: T): ValueExpectation<T>;
export function expect(actual: unknown): AsyncExpectation | object | ValueExpectation<unknown> {
  const internals = locatorInternals(actual);
  if (internals !== undefined) return createAsyncExpectation(internals);
  const attached = expectationSlot.get(actual);
  if (attached !== undefined) return attached;
  return createValueExpectation(actual);
}
