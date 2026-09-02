/** The backend error contract: closed codes and closed retryability, local and foreign. */

import { describe, expect, it } from 'vitest';
import { BACKEND_ERROR_CODES, BackendError, RETRYABLE_BACKEND_ERROR_CODES } from '../../src/backend/contract.ts';
import { asBackendError } from '../../src/internal/errors.ts';

/** A BackendError thrown by another copy of the module: same shape, different class. */
function foreign(code: string, retryable: boolean): Error {
  const error = new Error(`foreign ${code}`);
  error.name = 'BackendError';
  Object.assign(error, { code, retryable });
  return error;
}

describe('BackendError retryability', () => {
  it('keeps a legal retryable claim', () => {
    for (const code of RETRYABLE_BACKEND_ERROR_CODES) {
      const error = new BackendError(code, 'again', { retryable: true });
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(true);
    }
  });

  it('coerces an illegal retryable claim to a non-retryable BACKEND_FAILURE', () => {
    for (const code of BACKEND_ERROR_CODES) {
      if (RETRYABLE_BACKEND_ERROR_CODES.has(code)) continue;
      const error = new BackendError(code, 'maybe committed', { retryable: true });
      expect(error.code).toBe('BACKEND_FAILURE');
      expect(error.retryable).toBe(false);
    }
  });

  it('never rewrites a non-retryable error', () => {
    const error = new BackendError('ACTION_MAY_HAVE_COMMITTED', 'sent', { retryable: false });
    expect(error.code).toBe('ACTION_MAY_HAVE_COMMITTED');
  });
});

describe('asBackendError', () => {
  it('recognizes a foreign instance structurally and keeps a legal retryable claim', () => {
    expect(asBackendError(foreign('NODE_STALE', true))).toEqual({
      code: 'NODE_STALE',
      message: 'foreign NODE_STALE',
      retryable: true,
    });
  });

  it('holds a foreign instance to the retryability rule', () => {
    expect(asBackendError(foreign('ACTION_MAY_HAVE_COMMITTED', true))).toEqual({
      code: 'BACKEND_FAILURE',
      message: 'foreign ACTION_MAY_HAVE_COMMITTED',
      retryable: false,
    });
  });

  it('ignores errors outside the closed code set', () => {
    expect(asBackendError(foreign('SOMETHING_ELSE', false))).toBeUndefined();
    expect(asBackendError(new Error('plain'))).toBeUndefined();
    expect(asBackendError('string')).toBeUndefined();
  });
});
