import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/resolve.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import { serializeError, TestError } from '../../src/internal/errors.ts';
import { adoptSecrets, carriedSecrets, processSecrets, redactForSession, registerStaticSecrets, redactsDownloads, sessionLedger, staticSecretLedger } from '../../src/run/secrecy.ts';

const STATIC_VALUE = 'static-config-password-5521';
const PROVIDER_VALUE = 'provider-minted-token-8804';

const secrets: ResolvedConfig['secrets'] = new Map([
  ['password', { name: 'password', purpose: 'password', value: STATIC_VALUE }],
  ['token', { name: 'token', purpose: 'generic-secret', value: () => PROVIDER_VALUE }],
]);

/** A fresh session key; the ledger is keyed by session identity only. */
function newSession(): TargetSession {
  return {} as unknown as TargetSession;
}

describe('session secrecy carried across save and restore', () => {
  it('carries the provider values, leaving static values to each session', () => {
    const saving = sessionLedger(newSession(), secrets);
    saving.register('token', PROVIDER_VALUE);
    expect(carriedSecrets(saving, secrets)).toEqual([['token', PROVIDER_VALUE]]);
  });

  it('seeds the restoring session and the process ledger with the carried values', () => {
    const restoring = sessionLedger(newSession(), secrets);
    const value = 'provider-minted-token-adopted-2290';
    expect(processSecrets.redact(value)).toBe(value);
    adoptSecrets(restoring, [['token', value]]);
    expect(restoring.redact(`echo ${value}`)).toBe('echo <secret:token>');
    expect(processSecrets.redact(`log ${value}`)).toBe('log <secret:token>');
  });
});

describe('session download redaction', () => {
  it('rewrites downloads whenever the ledger holds a value', () => {
    expect(redactsDownloads(sessionLedger(newSession(), secrets))).toBe(true);
    const unsecret = sessionLedger(newSession(), new Map());
    expect(redactsDownloads(unsecret)).toBe(false);
    unsecret.register('token', PROVIDER_VALUE);
    expect(redactsDownloads(unsecret)).toBe(true);
  });
});

describe('redaction before and after a session opens', () => {
  it('redacts the static values with no session, and every value the session learned once one is open', () => {
    expect(redactForSession(undefined, secrets, `title ${STATIC_VALUE}`)).toBe('title <secret:password>');
    // A provider value is not known before it resolves.
    expect(redactForSession(undefined, secrets, `title ${PROVIDER_VALUE}`)).toBe(`title ${PROVIDER_VALUE}`);
    const session = newSession();
    sessionLedger(session, secrets).register('token', PROVIDER_VALUE);
    expect(redactForSession(session, secrets, `${STATIC_VALUE} ${PROVIDER_VALUE}`)).toBe('<secret:password> <secret:token>');
  });

  it('keeps one static ledger per secrets map, untouched by what a session learns', () => {
    const ledger = staticSecretLedger(secrets);
    expect(staticSecretLedger(secrets)).toBe(ledger);
    sessionLedger(newSession(), secrets).register('token', PROVIDER_VALUE);
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
