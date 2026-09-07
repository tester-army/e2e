/** The engine error contract: closed codes and closed retryability, local and foreign. */

import { describe, expect, it } from 'vitest';
import { ENGINE_ERROR_CODES, EngineError, RETRYABLE_ENGINE_ERROR_CODES } from '../../src/engine/contract.ts';
import { asEngineError } from '../../src/internal/errors.ts';

/** An EngineError thrown by another copy of the module: same shape, different class. */
function foreign(code: string, retryable: boolean): Error {
  const error = new Error(`foreign ${code}`);
  error.name = 'EngineError';
  Object.assign(error, { code, retryable });
  return error;
}

describe('EngineError retryability', () => {
  it('keeps a legal retryable claim', () => {
    for (const code of RETRYABLE_ENGINE_ERROR_CODES) {
      const error = new EngineError(code, 'again', { retryable: true });
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(true);
    }
  });

  it('coerces an illegal retryable claim to a non-retryable ENGINE_FAILURE', () => {
    for (const code of ENGINE_ERROR_CODES) {
      if (RETRYABLE_ENGINE_ERROR_CODES.has(code)) continue;
      const error = new EngineError(code, 'maybe committed', { retryable: true });
      expect(error.code).toBe('ENGINE_FAILURE');
      expect(error.retryable).toBe(false);
    }
  });

  it('never rewrites a non-retryable error', () => {
    const error = new EngineError('ACTION_MAY_HAVE_COMMITTED', 'sent', { retryable: false });
    expect(error.code).toBe('ACTION_MAY_HAVE_COMMITTED');
  });
});

describe('asEngineError', () => {
  it('recognizes a foreign instance structurally and keeps a legal retryable claim', () => {
    expect(asEngineError(foreign('NODE_STALE', true))).toEqual({
      code: 'NODE_STALE',
      message: 'foreign NODE_STALE',
      retryable: true,
    });
  });

  it('holds a foreign instance to the retryability rule', () => {
    expect(asEngineError(foreign('ACTION_MAY_HAVE_COMMITTED', true))).toEqual({
      code: 'ENGINE_FAILURE',
      message: 'foreign ACTION_MAY_HAVE_COMMITTED',
      retryable: false,
    });
  });

  it('ignores errors outside the closed code set', () => {
    expect(asEngineError(foreign('SOMETHING_ELSE', false))).toBeUndefined();
    expect(asEngineError(new Error('plain'))).toBeUndefined();
    expect(asEngineError('string')).toBeUndefined();
  });
});
