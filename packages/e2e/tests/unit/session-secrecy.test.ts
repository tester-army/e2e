import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/resolve.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import { adoptSecrecy, carriedSecrecy, processSecrets, sessionSecrecy } from '../../src/run/secrecy.ts';

const STATIC_VALUE = 'static-config-password-5521';
const PROVIDER_VALUE = 'provider-minted-token-8804';

const secrets: ResolvedConfig['secrets'] = new Map([
  ['password', { name: 'password', purpose: 'password', value: STATIC_VALUE }],
  ['token', { name: 'token', purpose: 'generic-secret', value: () => PROVIDER_VALUE }],
]);

/** A fresh session key; secrecy state is keyed by session identity only. */
function newSession(): TargetSession {
  return {} as unknown as TargetSession;
}

describe('session secrecy carried across save and restore', () => {
  it('carries the provider values and the taint, leaving static values to each session', () => {
    const saving = sessionSecrecy(newSession(), secrets);
    saving.ledger.register('token', PROVIDER_VALUE);
    saving.exposure.raise('filled');
    expect(carriedSecrecy(saving, secrets)).toEqual({ secrets: [['token', PROVIDER_VALUE]], tainted: true });
  });

  it('seeds the restoring session and the process ledger with the carried values, and its taint', () => {
    const restoring = sessionSecrecy(newSession(), secrets);
    const value = 'provider-minted-token-adopted-2290';
    expect(processSecrets.redact(value)).toBe(value);
    adoptSecrecy(restoring, { secrets: [['token', value]], tainted: true });
    expect(restoring.ledger.redact(`echo ${value}`)).toBe('echo <secret:token>');
    expect(processSecrets.redact(`log ${value}`)).toBe('log <secret:token>');
    expect(restoring.exposure.carriesTaint).toBe(true);
  });

  it('never clears a taint the restoring session already carries', () => {
    const restoring = sessionSecrecy(newSession(), secrets);
    restoring.exposure.raise('filled');
    adoptSecrecy(restoring, { secrets: [], tainted: false });
    expect(restoring.exposure.carriesTaint).toBe(true);
  });
});

describe('session exposure', () => {
  it('rewrites recordings once the engine holds a secret, and withholds pixels only after a fill', () => {
    const secrecy = sessionSecrecy(newSession(), secrets);
    expect(secrecy.exposure).toMatchObject({ withholdsPixels: false, redactsRecordings: false, carriesTaint: false });
    secrecy.exposure.raise('engine');
    expect(secrecy.exposure).toMatchObject({ withholdsPixels: false, redactsRecordings: true, carriesTaint: false });
    secrecy.exposure.raise('filled');
    expect(secrecy.exposure).toMatchObject({ withholdsPixels: true, redactsRecordings: true, carriesTaint: true });
  });

  it('carries only a fill into a saved session, and never falls back to a lower level', () => {
    const engineHeld = sessionSecrecy(newSession(), secrets);
    engineHeld.exposure.raise('engine');
    expect(carriedSecrecy(engineHeld, secrets).tainted).toBe(false);
    engineHeld.exposure.raise('filled');
    engineHeld.exposure.raise('engine');
    expect(engineHeld.exposure.withholdsPixels).toBe(true);
    expect(carriedSecrecy(engineHeld, secrets).tainted).toBe(true);
  });
});
