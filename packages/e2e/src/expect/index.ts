/** Public expect() dispatcher (spec api/e2e.d.ts). */

import type { AsyncExpectation, Locator, ValueExpectation, Web, WebExpectation } from '../types.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { locatorInternals } from '../locator/screen.ts';
import { createAsyncExpectation, createWebExpectation, type WebExpectTarget } from './async.ts';
import { createValueExpectation } from './values.ts';

/**
 * The target hangs off the web fixture under a global symbol so that an
 * expect() imported in an isolated test-module realm can still reach it.
 */
const webTargetSlot = realmSlot<WebExpectTarget>('e2e.webExpectTarget.v1');

/** Registers a web fixture instance so expect(web) can reach the driver. */
export function registerWebExpectTarget(web: object, target: WebExpectTarget): void {
  webTargetSlot.set(web, target);
}

/** Creates deterministic or async e2e expectations. */
export function expect(actual: Locator): AsyncExpectation;
export function expect(actual: Web): WebExpectation;
export function expect<T>(actual: T): ValueExpectation<T>;
export function expect(actual: unknown): AsyncExpectation | WebExpectation | ValueExpectation<unknown> {
  const internals = locatorInternals(actual);
  if (internals !== undefined) return createAsyncExpectation(internals);
  const webTarget = webTargetSlot.get(actual);
  if (webTarget !== undefined) return createWebExpectation(webTarget);
  return createValueExpectation(actual);
}
