/**
 * Playwright error translation at the engine contract boundary: what the
 * runner is allowed to retry, what it must surface, and what must pass through
 * untouched because it is already classified.
 */

import { describe, expect, it } from 'vitest';
import { EngineError } from 'e2e/engine';
import { ConfigurationError, TestError } from 'e2e/engine';
import { navigationStaleOr, staleOr, translatePwError } from '../../src/support.ts';

function pwTimeout(text: string): Error {
  const error = new Error(text);
  error.name = 'TimeoutError';
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

  it('maps a timeout to a non-retryable OPERATION_TIMEOUT', () => {
    const error = translatePwError(pwTimeout('waiting for locator'), 'observe');
    expect(error).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
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
