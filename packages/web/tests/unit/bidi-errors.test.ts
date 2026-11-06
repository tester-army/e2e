/**
 * The BiDi driver's error classification: a gone node, frame, or document is
 * retryable `NODE_STALE`, a classified error passes untouched, anything else
 * is `ENGINE_FAILURE`; and the stale fallback and quiet release helpers.
 */

import { describe, expect, it } from 'vitest';
import { EngineError, TestError } from 'e2e/engine';
import { BidiError, classify, isStale, releaseQuietly, ScriptError, unlessStale } from '../../src/errors.ts';

describe('classify', () => {
  it.each([
    new BidiError('script.callFunction', 'no such node', 'Node with given id does not belong to the document'),
    new BidiError('browsingContext.getTree', 'no such frame', 'Context abc not found'),
    new ScriptError('Execution context was destroyed, most likely because of a navigation'),
    new ScriptError('element is detached'),
    new BidiError('script.callFunction', 'unknown error', 'Inspected target navigated or closed'),
  ])('reads a gone node, frame, or document as retryable NODE_STALE: %s', (cause) => {
    const error = classify(cause, 'tap');
    expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(error.message).toMatch(/^tap: /);
    expect(isStale(cause)).toBe(true);
  });

  it('passes a classified error through untouched', () => {
    const timeout = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const invalid = new TestError('INVALID_LOCATOR', 'bad selector');
    expect(classify(timeout, 'locate')).toBe(timeout);
    expect(classify(invalid, 'locate')).toBe(invalid);
  });

  it('reads any other failure as ENGINE_FAILURE keeping its cause', () => {
    const cause = new BidiError('browsingContext.navigate', 'unknown error', 'net::ERR_CONNECTION_REFUSED');
    const error = classify(cause, 'navigation');
    expect(error).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(error.cause).toBe(cause);
    expect(isStale(new BidiError('browsingContext.navigate', 'unknown error', 'net::ERR_NAME_NOT_RESOLVED'))).toBe(false);
    expect(classify(new Error('boom'), 'observe')).toMatchObject({ code: 'ENGINE_FAILURE', message: 'observe: boom' });
    expect(isStale(new Error('boom'))).toBe(false);
  });
});

describe('unlessStale', () => {
  it('falls back only for a gone node or document', async () => {
    await expect(unlessStale(Promise.reject(new BidiError('m', 'no such node', '')), 'fallback')).resolves.toBe('fallback');
    await expect(unlessStale(Promise.resolve('value'), 'fallback')).resolves.toBe('value');
    await expect(unlessStale(Promise.reject(new BidiError('m', 'invalid argument', '')), 'fallback')).rejects.toBeInstanceOf(BidiError);
  });
});

describe('releaseQuietly', () => {
  it('settles whatever the release does', async () => {
    await expect(releaseQuietly(Promise.reject(new Error('already gone')))).resolves.toBeUndefined();
    await expect(releaseQuietly(undefined)).resolves.toBeUndefined();
  });
});
