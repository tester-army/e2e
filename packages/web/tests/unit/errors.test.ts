/** Recognizing a runner error by its code, whichever copy of `e2e` raised it. */

import { describe, expect, it } from 'vitest';
import { ConfigurationError, EngineError, TestError } from 'e2e/engine';
import { isTestErrorCode } from '../../src/errors.ts';

/** A runner error the way it arrives from a copy of `e2e` this module never imported. */
function foreignTestError(code: string): Error {
  const error = new Error(code);
  error.name = 'TestError';
  Object.assign(error, { category: 'test', code, retryable: false });
  return error;
}

describe('isTestErrorCode', () => {
  it('matches the code on a TestError from this module copy', () => {
    expect(isTestErrorCode(new TestError('LOCATOR_NOT_FOUND', 'gone'), 'LOCATOR_NOT_FOUND')).toBe(true);
    expect(isTestErrorCode(new TestError('LOCATOR_AMBIGUOUS', 'two'), 'LOCATOR_NOT_FOUND')).toBe(false);
  });

  it('matches the code on a TestError from another module copy, where instanceof says no', () => {
    const foreign = foreignTestError('LOCATOR_NOT_FOUND');
    expect(foreign instanceof TestError).toBe(false);
    expect(isTestErrorCode(foreign, 'LOCATOR_NOT_FOUND')).toBe(true);
    expect(isTestErrorCode(foreign, 'LOCATOR_AMBIGUOUS')).toBe(false);
  });

  it('never matches another class carrying the same code', () => {
    const engine = new EngineError('NODE_STALE', 'engine says', { retryable: true });
    expect(isTestErrorCode(engine, 'NODE_STALE')).toBe(false);
    expect(isTestErrorCode(new ConfigurationError('LOCATOR_NOT_FOUND', 'config says'), 'LOCATOR_NOT_FOUND')).toBe(false);
    expect(isTestErrorCode('LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND')).toBe(false);
  });
});
