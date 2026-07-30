/**
 * Playwright error translation at the driver SPI boundary (spec/09-drivers.md
 * "Errors"): what the runner is allowed to retry, and what it must surface.
 */

import { describe, expect, it } from 'vitest';
import { DriverError } from 'e2e/driver';
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
  it('passes driver errors through untouched', () => {
    const original = new DriverError('NODE_STALE', 'gone', { retryable: true });
    expect(translatePwError(original, 'observe')).toBe(original);
  });

  it('maps a timeout to a non-retryable OPERATION_TIMEOUT', () => {
    const error = translatePwError(pwTimeout('waiting for locator'), 'observe');
    expect(error.code).toBe('OPERATION_TIMEOUT');
    expect(error.retryable).toBe(false);
  });
});

describe('navigationStaleOr', () => {
  it.each(NAVIGATION_RACES)('reports a capture that lost its document as retryable: %s', (text) => {
    const error = navigationStaleOr(new Error(text), 'observe');
    expect(error.code).toBe('NODE_STALE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('observe:');
  });

  it('keeps a timeout a timeout: a capture that ran out of budget is not a race', () => {
    const error = navigationStaleOr(pwTimeout('observation capture timed out'), 'observe');
    expect(error.code).toBe('OPERATION_TIMEOUT');
    expect(error.retryable).toBe(false);
  });

  it('leaves every other failure a non-retryable DRIVER_FAILURE', () => {
    const error = navigationStaleOr(new Error('protocol error'), 'observe');
    expect(error.code).toBe('DRIVER_FAILURE');
    expect(error.retryable).toBe(false);
  });

  it('never reclassifies a driver error the capture already classified', () => {
    const original = new DriverError('DRIVER_FAILURE', 'Execution context was destroyed', {
      retryable: false,
    });
    expect(navigationStaleOr(original, 'observe')).toBe(original);
  });
});

describe('staleOr', () => {
  it.each(NAVIGATION_RACES)('treats a navigation race like a stale node: %s', (text) => {
    const error = staleOr(new Error(text), 'read');
    expect(error.code).toBe('NODE_STALE');
    expect(error.retryable).toBe(true);
  });

  it('still reports detachment and misses as stale', () => {
    expect(staleOr(new Error('element is not attached to the DOM'), 'read').code).toBe('NODE_STALE');
    expect(staleOr(pwTimeout('waiting for element'), 'read').retryable).toBe(true);
  });
});
