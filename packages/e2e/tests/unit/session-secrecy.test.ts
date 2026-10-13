import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/resolve.ts';
import { secrets as handles } from '../../src/secrets.ts';
import { SecretLedger } from '../../src/internal/redact.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import { serializeError, TestError } from '../../src/internal/errors.ts';
import { hasOpaqueSecretDefinitions, adoptSecrecy, carriedSecrecy, processSecrets, redactForSession, registerStaticSecrets, redactsDownloads, resolveSecretValue, secretPublicationProven, prospectiveSecretResolutionsProven, secretResolutionsProven, settleSecretResolutions, sessionSecrecy, staticSecretLedger } from '../../src/run/secrecy.ts';

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
  it('withholds pixels and carries the taint into a saved session only after a fill', () => {
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

describe('runner-owned resolution proof', () => {
  it('tracks actual resolution through provider completion and derived registration without invoking unused providers', async () => {
    let release!: () => void;
    let unused = 0;
    const wait = new Promise<void>((done) => { release = done; });
    const config: ResolvedConfig['allSecrets'] = new Map([
      ['pending', { name: 'pending', purpose: 'generic-secret', value: async () => { await wait; return 'resolved-token-H7q3'; } }],
      ['unused', { name: 'unused', purpose: 'generic-secret', value: () => { unused++; return 'unused-token-H7q3'; } }],
    ]);
    const secrecy = sessionSecrecy(newSession(), config);
    expect(secretResolutionsProven(secrecy.ledger)).toBe(true);
    const resolving = resolveSecretValue(handles.get('pending'), config, secrecy.ledger, (value) => {
      expect(secretResolutionsProven(secrecy.ledger)).toBe(false);
      return ['derived-' + value];
    });
    expect(secretResolutionsProven(secrecy.ledger)).toBe(false);
    expect(await settleSecretResolutions(secrecy.ledger, 0)).toBe(false);
    expect(await settleSecretResolutions(secrecy.ledger, 5)).toBe(false);
    release();
    await resolving;
    expect(await settleSecretResolutions(secrecy.ledger, 5)).toBe(true);
    expect(secrecy.ledger.redact('derived-resolved-token-H7q3')).toBe('<secret:pending>');
    expect(unused).toBe(0);
    expect(Object.keys(secrecy)).toEqual(['ledger', 'exposure']);
  });

  it('settles within the remaining budget, including overlapping resolutions', async () => {
    const config: ResolvedConfig['allSecrets'] = new Map([['pending', {
      name: 'pending', purpose: 'generic-secret', value: async () => {
        await new Promise((done) => setTimeout(done, 5));
        return 'overlap-token-H7q3';
      },
    }]]);
    const secrecy = sessionSecrecy(newSession(), config);
    const work = [resolveSecretValue(handles.get('pending'), config, secrecy.ledger), resolveSecretValue(handles.get('pending'), config, secrecy.ledger)];
    expect(await settleSecretResolutions(secrecy.ledger, 100)).toBe(true);
    await Promise.all(work);
  });

  it('fails closed after a rejected or invalid provider rather than claiming its unknown value was redacted', async () => {
    for (const provider of [() => { throw new Error('provider failed'); }, () => 'tiny']) {
      const config: ResolvedConfig['allSecrets'] = new Map([['failed', { name: 'failed', purpose: 'generic-secret', value: provider }]]);
      const secrecy = sessionSecrecy(newSession(), config);
      await expect(resolveSecretValue(handles.get('failed'), config, secrecy.ledger)).rejects.toThrow();
      expect(await settleSecretResolutions(secrecy.ledger, 20)).toBe(false);
    }
  });
});


describe('prospective publication proof', () => {
  it('never confuses an unused or already resolved fresh provider with closed-world knowledge', async () => {
    let calls = 0;
    const config: ResolvedConfig['allSecrets'] = new Map([['rotating', { name: 'rotating', purpose: 'generic-secret', value: () => ++calls === 1 ? 'first-value-P9h8' : 'second-value-R7j4' }]]);
    const secrecy = sessionSecrecy(newSession(), config);
    expect(secretResolutionsProven(secrecy.ledger)).toBe(true);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger, 'sdk-facts')).toBe(true);
    expect(calls).toBe(0);
    await resolveSecretValue(handles.get('rotating'), config, secrecy.ledger);
    expect(secretResolutionsProven(secrecy.ledger)).toBe(true);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(calls).toBe(1);
    await resolveSecretValue(handles.get('rotating'), config, secrecy.ledger);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(calls).toBe(2);
  });

  it('binds layered definitions and their static redaction without replacing an opaque alias', () => {
    let calls = 0;
    const session = newSession();
    const first: ResolvedConfig['allSecrets'] = new Map([['literal', { name: 'literal', purpose: 'generic-secret', value: 'literal-secret-H8k2' }]]);
    const secrecy = sessionSecrecy(session, first);
    expect(secretPublicationProven(secrecy.ledger)).toBe(true);
    const alias: ResolvedConfig['allSecrets'] = new Map([['credential.password', { name: 'credential.password', purpose: 'password', value: () => { calls++; return 'alias-secret-B4j7'; } }]]);
    expect(sessionSecrecy(session, alias)).toBe(secrecy);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    const later: ResolvedConfig['allSecrets'] = new Map([['later', { name: 'later', purpose: 'generic-secret', value: 'layered-secret-L6j3' }]]);
    sessionSecrecy(session, later);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(secrecy.ledger.redact('layered-secret-L6j3')).toBe('<secret:later>');
    expect(calls).toBe(0);
  });

  it('fails closed for an unbound ledger but leaves static and empty effective configurations proven', () => {
    const empty = sessionSecrecy(newSession(), new Map());
    expect(secretPublicationProven(empty.ledger)).toBe(true);
    const literal = sessionSecrecy(newSession(), new Map([['literal', { name: 'literal', purpose: 'generic-secret', value: 'literal-secret-A6r2' }]]));
    expect(secretPublicationProven(literal.ledger)).toBe(true);
    const unbound = new SecretLedger();
    expect(secretPublicationProven(unbound)).toBe(false);
    expect(prospectiveSecretResolutionsProven(unbound, 'sdk-facts')).toBe(false);
  });
});


describe('descriptor-based prospective accounting', () => {
  it('never invokes accessor-backed effective definitions while accounting or proving', async () => {
    let calls = 0;
    const definition = { name: 'lazy', purpose: 'generic-secret' as const, get value() { calls++; return 'lazy-value-' + calls + '-A9g2'; } };
    const layer = new Map([['lazy', definition]]);
    const session = newSession();
    const secrecy = sessionSecrecy(session, layer);
    expect(calls).toBe(0);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger, 'sdk-facts')).toBe(true);
    expect(calls).toBe(0);
    await resolveSecretValue(handles.get('lazy'), layer, secrecy.ledger);
    expect(calls).toBe(1);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(calls).toBe(1);
    sessionSecrecy(session, new Map());
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(calls).toBe(1);
  });

  it('seeds EVERY literal in a resolution-only layer before the first actual handoff', async () => {
    const ledger = new SecretLedger();
    const layer: ResolvedConfig['allSecrets'] = new Map([
      ['requested', { name: 'requested', purpose: 'generic-secret', value: 'requested-value-A4h9' }],
      ['other', { name: 'other', purpose: 'generic-secret', value: 'never-resolved-literal-P4k7' }],
    ]);
    await resolveSecretValue(handles.get('requested'), layer, ledger, () => {
      expect(ledger.redact('never-resolved-literal-P4k7')).toBe('<secret:other>');
      return [];
    });
    expect(secretPublicationProven(ledger)).toBe(true);
    expect(ledger.redact('never-resolved-literal-P4k7')).toBe('<secret:other>');
    expect(processSecrets.redact('never-resolved-literal-P4k7')).toBe('<secret:other>');
  });

  it('never upgrades a previously opaque layer when its descriptor later becomes literal', async () => {
    const definition = { name: 'rotating', purpose: 'generic-secret' as const, value: (() => 'rotating-value-A3h8') as string | (() => string) };
    const layer = new Map([['rotating', definition]]);
    const session = newSession();
    const secrecy = sessionSecrecy(session, layer);
    await resolveSecretValue(handles.get('rotating'), layer, secrecy.ledger);
    definition.value = 'later-literal-B5k8';
    sessionSecrecy(session, layer);
    expect(secretPublicationProven(secrecy.ledger)).toBe(false);
    expect(secrecy.ledger.redact('later-literal-B5k8')).toBe('<secret:rotating>');
  });
});

it('classifies getters without reading and tracks only requested getter failures and derived handoff', async () => {
  let calls = 0;
  const layer: ResolvedConfig['allSecrets'] = new Map([
    ['lazy', { name: 'lazy', purpose: 'generic-secret', get value() {
      calls++;
      if (calls > 1) throw new Error('requested getter failed');
      return 'tracked-getter-secret-R8';
    } }],
    ['other', { name: 'other', purpose: 'generic-secret', value: 'other-layer-literal-R8' }],
  ]);
  expect(hasOpaqueSecretDefinitions(layer)).toBe(true);
  const session = newSession();
  const secrecy = sessionSecrecy(session, layer);
  staticSecretLedger(layer); registerStaticSecrets(layer); carriedSecrecy(secrecy, layer);
  expect(secretPublicationProven(secrecy.ledger)).toBe(false);
  expect(prospectiveSecretResolutionsProven(secrecy.ledger, 'sdk-facts')).toBe(true);
  expect(calls).toBe(0);
  await resolveSecretValue(handles.get('lazy'), layer, secrecy.ledger, (value) => {
    expect(secretResolutionsProven(secrecy.ledger)).toBe(false);
    expect(secrecy.ledger.redact('other-layer-literal-R8')).toBe('<secret:other>');
    return ['derived-' + value];
  });
  expect(calls).toBe(1);
  expect(secrecy.ledger.redact('derived-tracked-getter-secret-R8')).toBe('<secret:lazy>');
  expect(hasOpaqueSecretDefinitions(layer)).toBe(true);
  expect(secretPublicationProven(secrecy.ledger)).toBe(false);
  expect(calls).toBe(1);
  await expect(resolveSecretValue(handles.get('lazy'), layer, secrecy.ledger)).rejects.toThrow('requested getter failed');
  expect(calls).toBe(2);
  expect(await settleSecretResolutions(secrecy.ledger, 0)).toBe(false);
  expect(hasOpaqueSecretDefinitions(layer)).toBe(true);
  expect(calls).toBe(2);
});
