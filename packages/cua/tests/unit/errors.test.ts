import { describe, expect, it } from 'vitest';
import { EngineError } from '@e2edev/e2e/engine';
import { checkActionOutcome, translateThrown, translateToolError } from '../../src/errors.ts';
import { acted, failure, ok } from '../helpers/fake-client.ts';

describe('translateToolError', () => {
  it('maps stale handles to retryable NODE_STALE', () => {
    const error = translateToolError(failure('stale_element_token', 'token superseded'), 'perform tap');
    expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translateToolError(failure('snapshot_id_required'), 'x').code).toBe('NODE_STALE');
    expect(translateToolError(failure('', 'element token is stale'), 'x').code).toBe('NODE_STALE');
  });

  it('maps window and refusal codes onto the contract', () => {
    expect(translateToolError(failure('window_id_not_found'), 'observe').code).toBe('INVALID_STATE');
    expect(translateToolError(failure('background_occluded'), 'perform tap').code).toBe('NOT_ACTIONABLE');
    expect(translateToolError(failure('unsupported_action'), 'perform hover').code).toBe('UNSUPPORTED_CAPABILITY');
    expect(translateToolError(failure('boom', 'timed out waiting'), 'observe').code).toBe('OPERATION_TIMEOUT');
    expect(translateToolError(failure('other', 'something else'), 'observe').code).toBe('ENGINE_FAILURE');
  });

  it('names the permission remedy for a missing grant', () => {
    const error = translateToolError(failure('', 'Accessibility: NOT granted.'), 'observe');
    expect(error.code).toBe('ENGINE_FAILURE');
    expect(error.message).toMatch(/System Settings/);
  });
});

describe('translateThrown', () => {
  it('passes classified errors through and maps the driver variants', () => {
    const engine = new EngineError('NOT_ACTIONABLE', 'no', { retryable: false });
    expect(translateThrown(engine, 'x')).toBe(engine);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect((translateThrown(abort, 'perform tap') as EngineError).code).toBe('CANCELLED');
    class Shutdown_ extends Error {}
    expect((translateThrown(new Shutdown_('DriverError.Shutdown'), 'x') as EngineError).code).toBe('INVALID_STATE');
    class ActionInterrupted_ extends Error {}
    expect((translateThrown(new ActionInterrupted_('DriverError.ActionInterrupted'), 'x') as EngineError).code).toBe(
      'ACTION_MAY_HAVE_COMMITTED',
    );
    expect((translateThrown(new Error('kaboom'), 'x') as EngineError).code).toBe('ENGINE_FAILURE');
  });
});

describe('checkActionOutcome', () => {
  it('accepts confirmed and unverifiable effects', () => {
    expect(() => checkActionOutcome(acted('confirmed'), 'x')).not.toThrow();
    expect(() => checkActionOutcome(acted('unverifiable'), 'x')).not.toThrow();
    expect(() => checkActionOutcome(ok(), 'x')).not.toThrow();
  });

  it('turns a partial delivery into ACTION_MAY_HAVE_COMMITTED and a refusal into NOT_ACTIONABLE', () => {
    expect(() => checkActionOutcome(acted('partial'), 'perform fill')).toThrow(
      expect.objectContaining({ code: 'ACTION_MAY_HAVE_COMMITTED' }),
    );
    expect(() => checkActionOutcome(acted('refused'), 'perform tap')).toThrow(expect.objectContaining({ code: 'NOT_ACTIONABLE' }));
    expect(() => checkActionOutcome(failure('stale_element_token'), 'perform tap')).toThrow(
      expect.objectContaining({ code: 'NODE_STALE' }),
    );
  });

  it('reads the effect from structured JSON when the typed record is absent', () => {
    expect(() => checkActionOutcome(ok({ action: { effect: 'Partial' } }), 'x')).toThrow(
      expect.objectContaining({ code: 'ACTION_MAY_HAVE_COMMITTED' }),
    );
  });
});
