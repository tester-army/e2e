/**
 * Playwright error translation at the engine contract boundary: what the
 * runner is allowed to retry, what it must surface, and what must pass through
 * untouched because it is already classified.
 */

import { describe, expect, it } from 'vitest';
import { EngineError } from 'e2e/engine';
import { ConfigurationError, TestError } from 'e2e/engine';
import { isTestErrorCode, navigationStaleOr, staleOr, translatePwError } from '../../src/support.ts';

function pwTimeout(text: string): Error {
  const error = new Error(text);
  error.name = 'TimeoutError';
  return error;
}

/** A runner error the way it arrives from a copy of `e2e` this module never imported. */
function foreignTestError(code: string): Error {
  const error = new Error(code);
  error.name = 'TestError';
  Object.assign(error, { category: 'test', code, retryable: false });
  return error;
}

const NAVIGATION_RACES = [
  'jsHandle.getProperties: Execution context was destroyed, most likely because of a navigation',
  'locator.evaluate: Frame was detached',
  'Execution context was destroyed, most likely because of a navigation.',
];

describe('translatePwError', () => {
  it('passes engine errors through untouched', () => {
    const original = new EngineError('NODE_STALE', 'gone', { retryable: true });
    expect(translatePwError(original, 'observe')).toBe(original);
  });

  it('passes runner errors through untouched: policy never becomes infrastructure', () => {
    const denied = new ConfigurationError('POLICY_DENIED', 'origin not allowed');
    expect(translatePwError(denied, 'navigation')).toBe(denied);
    const invalid = new TestError('INVALID_ARGUMENT', 'not JSON');
    expect(translatePwError(invalid, 'evaluate')).toBe(invalid);
  });

  it('recognizes an EngineError from another module copy structurally', () => {
    const foreign = new Error('stale');
    foreign.name = 'EngineError';
    Object.assign(foreign, { code: 'NODE_STALE', retryable: true });
    expect(translatePwError(foreign, 'read')).toBe(foreign);
  });

  it('passes a runner error from another module copy through untouched', () => {
    const foreign = foreignTestError('LOCATOR_AMBIGUOUS');
    expect(translatePwError(foreign, 'read')).toBe(foreign);
  });

  it('maps a timeout to a non-retryable OPERATION_TIMEOUT', () => {
    const error = translatePwError(pwTimeout('waiting for locator'), 'observe');
    expect(error).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  });
});

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

describe('navigationStaleOr', () => {
  it.each(NAVIGATION_RACES)('reports a capture that lost its document as retryable: %s', (text) => {
    const error = navigationStaleOr(new Error(text), 'observe');
    expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(error.message).toContain('observe:');
  });

  it('keeps a timeout a timeout: a capture that ran out of budget is not a race', () => {
    const error = navigationStaleOr(pwTimeout('observation capture timed out'), 'observe');
    expect(error).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  });

  it('leaves every other failure a non-retryable ENGINE_FAILURE', () => {
    const error = navigationStaleOr(new Error('protocol error'), 'observe');
    expect(error).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
  });

  it('never reclassifies an engine error the capture already classified', () => {
    const original = new EngineError('ENGINE_FAILURE', 'Execution context was destroyed', {
      retryable: false,
    });
    expect(navigationStaleOr(original, 'observe')).toBe(original);
  });
});

describe('staleOr', () => {
  it.each(NAVIGATION_RACES)('treats a navigation race like a stale node: %s', (text) => {
    const error = staleOr(new Error(text), 'read');
    expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('still reports detachment and misses as stale', () => {
    expect(staleOr(new Error('element is not attached to the DOM'), 'read')).toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
    });
  });

  it('keeps a timeout a timeout: locate resolves once and never waits', () => {
    expect(staleOr(pwTimeout('waiting for element'), 'read')).toMatchObject({
      code: 'OPERATION_TIMEOUT',
      retryable: false,
    });
  });
});
