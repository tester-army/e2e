/**
 * Playwright error translation at the engine contract boundary: what the
 * runner is allowed to retry, what it must surface, and what must pass through
 * untouched because it is already classified.
 */

import { describe, expect, it } from 'vitest';
import { EngineError } from 'e2e/engine';
import { ConfigurationError, TestError } from 'e2e/engine';
import type { Page } from 'playwright-core';
import { isTestErrorCode, navigationStaleOr, pageScriptFailure, staleOr, translatePwError } from '../../src/support.ts';

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
  'Execution context was destroyed, most likely because of a navigation.',
  'locator.evaluate: Frame was detached',
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
  it('reports a capture that lost its document as retryable', () => {
    for (const text of NAVIGATION_RACES) {
      const error = navigationStaleOr(new Error(text), 'observe');
      expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
      expect(error.message).toContain('observe:');
    }
  });

  it('keeps a timeout a timeout: a capture that ran out of budget is not a race', () => {
    const error = navigationStaleOr(pwTimeout('observation capture timed out'), 'observe');
    expect(error).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  });

  it.each(NAVIGATION_RACES)('keeps a timeout a timeout when its call log says %s', (line) => {
    const timeout = pwTimeout(`Timeout 5000ms exceeded.\nCall log:\n  - ${line}`);
    expect(navigationStaleOr(timeout, 'observe')).toMatchObject({
      code: 'OPERATION_TIMEOUT',
      retryable: false,
    });
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
  it('treats a navigation race like a stale node', () => {
    for (const text of NAVIGATION_RACES) {
      expect(staleOr(new Error(text), 'read')).toMatchObject({ code: 'NODE_STALE', retryable: true });
    }
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

  it.each([
    'resolved to hidden',
    'element is not attached to the DOM',
    'element was detached from the DOM',
    'no element found',
    'frame was detached',
  ])(
    'keeps a timeout a timeout when its call log says %s',
    (line) => {
      const timeout = pwTimeout(`Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('#x')\n  - locator ${line}`);
      expect(staleOr(timeout, 'read')).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    },
  );
});

describe('pageScriptFailure', () => {
  const pageError = new Error('locator.evaluateAll: TypeError: Map is not a constructor');

  /** A page whose `:root` answers the utility-world count with `counts` in turn and fails the main-world evaluate. */
  function probedPage(counts: readonly boolean[]): Page {
    let call = 0;
    const root = {
      count: async () => {
        if (!counts[call++]) throw new Error('Target page, context or browser has been closed');
        return 1;
      },
      evaluate: async () => {
        throw new Error('locator.evaluate: TypeError: Map is not a constructor');
      },
    };
    return { locator: () => root } as unknown as Page;
  }

  it('classifies a failure the page caused while both worlds answer around it', async () => {
    await expect(pageScriptFailure(probedPage([true, true]), pageError, 'locate', 1_000))
      .resolves.toMatchObject({ code: 'EVALUATE_FAILED', category: 'test' });
  });

  it('leaves a frame that stops answering after the main-world probe to infrastructure', async () => {
    await expect(pageScriptFailure(probedPage([true, false]), pageError, 'locate', 1_000)).resolves.toBeUndefined();
  });

  it('leaves a frame the utility world cannot read to infrastructure', async () => {
    await expect(pageScriptFailure(probedPage([false]), pageError, 'locate', 1_000)).resolves.toBeUndefined();
  });
});
