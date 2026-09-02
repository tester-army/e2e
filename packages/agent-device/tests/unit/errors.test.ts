import { describe, expect, it } from 'vitest';
import { AppError } from 'agent-device';
import { BackendError, TestError } from 'e2e/backend';
import { staleOr, translateError } from '../../src/errors.ts';

describe('error translation', () => {
  it('passes classified errors through untouched', () => {
    const backend = new BackendError('NOT_ACTIONABLE', 'no', { retryable: false });
    expect(translateError(backend, 'perform')).toBe(backend);
    const runner = new TestError('POLICY_DENIED', 'no');
    expect(staleOr(runner, 'perform')).toBe(runner);
  });

  it('maps a missing session to INVALID_STATE and unsupported operations to UNSUPPORTED_CAPABILITY', () => {
    expect(translateError(new AppError('SESSION_NOT_FOUND', 'session gone'), 'snapshot')).toMatchObject({
      code: 'INVALID_STATE',
      retryable: false,
    });
    expect(translateError(new Error('No active app session. Run open first.'), 'snapshot')).toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(translateError(new AppError('UNSUPPORTED_OPERATION', 'hover is macOS only'), 'perform hover')).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('maps timeouts, stale refs, and the rest', () => {
    expect(translateError(new Error('snapshot timed out after 30000ms'), 'snapshot')).toMatchObject({
      code: 'OPERATION_TIMEOUT',
    });
    expect(staleOr(new Error('ref @e12 not found in the current snapshot'), 'perform tap')).toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
    });
    expect(staleOr(new Error('Unknown ref: @e3'), 'perform tap')).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translateError(new Error('ref @e12 not found'), 'observe')).toMatchObject({ code: 'BACKEND_FAILURE' });
    const failure = translateError(new AppError('COMMAND_FAILED', 'xcrun exploded'), 'boot');
    expect(failure).toMatchObject({ code: 'BACKEND_FAILURE', retryable: false });
    expect(failure.message).toBe('boot failed: xcrun exploded');
  });

  it('turns an AbortError into CANCELLED', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(translateError(abort, 'snapshot')).toMatchObject({ code: 'CANCELLED' });
  });
});
