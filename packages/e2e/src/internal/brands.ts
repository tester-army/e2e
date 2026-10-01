/** Internal brand symbols backing the opaque spec types. */

export const secretBrand: unique symbol = Symbol.for('e2e.secret');
export const credentialBrand: unique symbol = Symbol.for('e2e.credential');
export const uniqueBrand: unique symbol = Symbol.for('e2e.unique');
export const testCaseBrand: unique symbol = Symbol.for('e2e.testCase');
export const engineBrand: unique symbol = Symbol.for('e2e.engine.v1');
export const locatorBrand: unique symbol = Symbol.for('e2e.locator');
/** Slot under which a fixture carries its attached expectation surface. */
export const expectationBrand: unique symbol = Symbol.for('e2e.expectation.v1');
/** Slot on `globalThis` naming the running attempt for `expect.poll`. */
export const attemptBrand: unique symbol = Symbol.for('e2e.attempt.v1');
/** Slot on `globalThis` holding the runner's view of which phase owns an `expect.poll`. */
export const pollScopesBrand: unique symbol = Symbol.for('e2e.pollScopes.v1');
