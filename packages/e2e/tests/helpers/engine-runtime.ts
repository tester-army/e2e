/**
 * The engine runtime from the built package. The in-memory engines the
 * integration suites hand to the built runner (run-project.ts) must throw the
 * runner's own `EngineError` and carry its brand, so `instanceof` checks
 * inside `dist` see the same class identities; every fake imports its runtime
 * from here. The specifier is kept non-literal so typechecking does not
 * require a prior build.
 */

import type { EngineErrorCode } from '../../src/engine/index.ts';

const builtEngineModule = '../../dist/engine/index.js';

const built = (await import(builtEngineModule)) as typeof import('../../src/engine/index.ts');

export const { defineEngine, ENGINE_SPI_VERSION, LOCATOR_ACTION_KINDS, POINTER_ACTION_KINDS, obj, parseKey, resolveExpression } =
  built;

/** A thrown `EngineError` from the built package, for a fake that fails on purpose. */
export function engineFailure(code: EngineErrorCode, message: string, retryable = false): InstanceType<typeof built.EngineError> {
  return new built.EngineError(code, message, { retryable });
}
