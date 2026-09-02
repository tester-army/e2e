/** Internal brand symbols backing the opaque spec types. */

export const secretBrand: unique symbol = Symbol.for('e2e.secret');
export const credentialBrand: unique symbol = Symbol.for('e2e.credential');
export const testCaseBrand: unique symbol = Symbol.for('e2e.testCase');
export const backendBrand: unique symbol = Symbol.for('e2e.backend.v1');
export const locatorBrand: unique symbol = Symbol.for('e2e.locator');
/** Slot under which a fixture carries its attached expectation surface. */
export const expectationBrand: unique symbol = Symbol.for('e2e.expectation.v1');
