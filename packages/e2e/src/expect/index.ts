/** Public expect() dispatcher (spec api/e2e.d.ts). */

import type { AsyncExpectation, Locator, ValueExpectation, Web, WebExpectation } from '../types.js';
import { locatorInternals } from '../locator/screen.js';
import { createAsyncExpectation, createWebExpectation, type WebExpectTarget } from './async.js';
import { createValueExpectation } from './values.js';

/**
 * The target hangs off the web fixture under a global symbol so that an
 * expect() imported in an isolated test-module realm can still reach it.
 */
const webTargetKey = Symbol.for('e2e.webExpectTarget.v1');

/** Registers a web fixture instance so expect(web) can reach the driver. */
export function registerWebExpectTarget(web: object, target: WebExpectTarget): void {
  Object.defineProperty(web, webTargetKey, { value: target, enumerable: false });
}

/** Creates deterministic or async e2e expectations. */
export function expect(actual: Locator): AsyncExpectation;
export function expect(actual: Web): WebExpectation;
export function expect<T>(actual: T): ValueExpectation<T>;
export function expect(actual: unknown): AsyncExpectation | WebExpectation | ValueExpectation<unknown> {
  const internals = locatorInternals(actual);
  if (internals !== undefined) return createAsyncExpectation(internals);
  if (typeof actual === 'object' && actual !== null) {
    const webTarget = (actual as Record<PropertyKey, unknown>)[webTargetKey] as
      | WebExpectTarget
      | undefined;
    if (webTarget !== undefined) return createWebExpectation(webTarget);
  }
  return createValueExpectation(actual);
}
