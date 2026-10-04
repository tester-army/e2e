import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/resolve.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import { serializeError, TestError } from '../../src/internal/errors.ts';
import { adoptSecrecy, carriedSecrecy, processSecrets, redactForSession, registerStaticSecrets, redactsDownloads, sessionSecrecy, staticSecretLedger } from '../../src/run/secrecy.ts';

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
<<<<<<< HEAD
  it('withholds pixels and carries the taint into a saved session only after a fill', () => {
=======
  it('rewrites downloads once the engine holds a secret, and withholds pixels only after a fill', () => {
>>>>>>> df8bf037 (fix: accept retired trace hooks from published engines, and word the replacement for this commit)
    const secrecy = sessionSecrecy(newSession(), secrets);
    expect(secrecy.exposure).toMatchObject({ withholdsPixels: false, carriesTaint: false });
    expect(carriedSecrecy(secrecy, secrets).tainted).toBe(false);
    secrecy.exposure.raise('filled');
    expect(secrecy.exposure).toMatchObject({ withholdsPixels: true, carriesTaint: true });
    expect(carriedSecrecy(secrecy, secrets).tainted).toBe(true);
  });

  it('rewrites recordings whenever the ledger holds a value, filled or not', () => {
    expect(redactsDownloads(sessionSecrecy(newSession(), secrets))).toBe(true);
    const unsecret = sessionSecrecy(newSession(), new Map());
    expect(redactsDownloads(unsecret)).toBe(false);
    unsecret.ledger.register('token', PROVIDER_VALUE);
    expect(redactsDownloads(unsecret)).toBe(true);
  });
});

describe('redaction before and after a session opens', () => {
  it('redacts the static values with no session, and every value the session learned once one is open', () => {
    expect(redactForSession(undefined, secrets, `title ${STATIC_VALUE}`)).toBe('title <secret:password>');
    // A provider value is not known before it resolves.
    expect(redactForSession(undefined, secrets, `title ${PROVIDER_VALUE}`)).toBe(`title ${PROVIDER_VALUE}`);
    const session = newSession();
    sessionSecrecy(session, secrets).ledger.register('token', PROVIDER_VALUE);
    expect(redactForSession(session, secrets, `${STATIC_VALUE} ${PROVIDER_VALUE}`)).toBe('<secret:password> <secret:token>');
  });

  it('keeps one static ledger per secrets map, untouched by what a session learns', () => {
    const ledger = staticSecretLedger(secrets);
    expect(staticSecretLedger(secrets)).toBe(ledger);
    sessionSecrecy(newSession(), secrets).ledger.register('token', PROVIDER_VALUE);
    expect(ledger.entries()).toEqual([['password', STATIC_VALUE]]);
  });

  it('makes the process ledger the default redactor once seeded, so a serialized error carries no secret', () => {
    const value = 'process-wide-ledger-value-3391';
    registerStaticSecrets(secrets);
    processSecrets.register('token', value);
    const serialized = serializeError(new TestError('ASSERTION_FAILED', `the app echoed ${value}`));
    expect(serialized.message).toBe('the app echoed <secret:token>');
  });
});
