/**
 * OrcaRouter's two credential entries, and the one credential they share.
 *
 * Every fake here uses a key that is obviously not real (`sk-orca-test…`), and
 * several assertions exist only to prove a key or a verifier cannot escape
 * into a URL, an error, or a progress line.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOAuthFetch } from '../../../src/oauth/fetch.ts';
import { createApiKeyProvider, createAuthProvider } from '../../../src/oauth/providers/orcarouter.ts';
import { orcarouterAuth } from '../../../src/oauth/orcarouter-auth.ts';
import { orcarouter } from '../../../src/oauth/orcarouter.ts';
import { authorizeUrl, catalogUrl, exchangeUrl, orcaRouterOrigins } from '../../../src/oauth/orcarouter-origins.ts';
import { getProvider } from '../../../src/oauth/providers.ts';
import { FileCredentialStore } from '../../../src/oauth/store.ts';
import type { OAuthCredentials } from '../../../src/oauth/types.ts';
import { MemoryCredentialStore } from './helpers/store.ts';
import { json, useServers, useVendor, type Received } from './helpers/server.ts';

const serve = useServers(afterEach);
const vendor = useVendor(afterEach);

const TEST_KEY = 'sk-orca-test-0123456789';

/**
 * The operator's own environment must never reach a test: a real
 * ORCAROUTER_API_KEY here would change what these tests assert and leak into
 * a failure message. Every OrcaRouter variable is cleared for the file.
 */
beforeEach(() => {
  for (const name of ['ORCAROUTER_API_KEY', 'ORCA_BASE_URL', 'ORCA_AUTH_BASE_URL', 'ORCA_API_BASE_URL']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const AUTH = 'https://www.orcarouter.ai';
const API = 'https://api.orcarouter.ai/v1';

interface CallbackInfo {
  readonly url: string;
  readonly instructions: string;
  readonly userCode?: string;
}

/** Captures what a flow tells the user, so an assertion can prove a secret is not in it. */
function recorder(onPrompt: (state: string) => string = () => TEST_KEY) {
  const auth: CallbackInfo[] = [];
  const progress: string[] = [];
  const controller = new AbortController();
  const history = (): string[] => [...auth.map((info) => info.url), ...progress];
  // Declared before `log` so the prompt callback can read the state onAuth published.
  const log = { auth } as { auth: CallbackInfo[] };
  const callbacks = {
    signal: controller.signal,
    onAuth: (info: CallbackInfo) => void auth.push(info),
    onProgress: (message: string) => void progress.push(message),
    // The state is read when the prompt is answered, which is after onAuth has fired.
    onPrompt: async () => onPrompt(stateOf(log)),
  };
  return {
    callbacks,
    auth,
    fail: () => controller.abort(),
    /** Everything the user saw: if a secret is here, it leaked. */
    transcript: () => history().join('\n'),
    urls: () => auth.map((info) => info.url),
  };
}

type Recorder = ReturnType<typeof recorder>;

function stateOf(log: { readonly auth: CallbackInfo[] }): string {
  const info = log.auth[0];
  return info === undefined ? '' : new URL(info.url).searchParams.get('state') ?? '';
}

function callbackOf(authorize: string): string {
  return new URL(authorize).searchParams.get('callback_url') ?? '';
}

/** Reads the published authorize URL, waiting for the flow to publish it. */
async function authorizeUrlOf(log: Recorder): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (log.auth.length === 0) {
    if (Date.now() > deadline) throw new Error('the flow never published an authorize URL');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return log.auth[0]!.url;
}

/** Walks the redirect where the listener actually binds. */
async function deliver(callback: string, mutate: (url: URL) => void = () => {}): Promise<number> {
  const target = new URL(callback);
  target.hostname = '127.0.0.1';
  mutate(target);
  const response = await fetch(target);
  await response.body?.cancel();
  return response.status;
}

interface LoginHarness {
  readonly exchange: { readonly url: string; readonly requests: readonly Received[] };
  readonly log: ReturnType<typeof recorder>;
  readonly settled: Promise<OAuthCredentials>;
}

/** Starts the sign-in adapter with a fake consent endpoint standing in for the auth origin. */
async function beginLogin(options: { readonly status?: number; readonly body?: unknown; readonly timeoutMs?: number; readonly onPrompt?: (state: string) => string; readonly env?: Record<string, string> } = {}): Promise<LoginHarness> {
  const exchange = await serve((_request, response) => json(response, options.status ?? 200, options.body ?? { key: TEST_KEY, user_id: '12345', scope: 'api' }));
  const log = recorder(options.onPrompt);
  const provider = createAuthProvider({ env: options.env ?? { ORCA_AUTH_BASE_URL: exchange.url }, loginTimeoutMs: options.timeoutMs ?? 5_000 });
  const settled = provider.login(log.callbacks);
  // A flow a test deliberately abandons rejects (CANCELLED); awaiting `settled` still sees it.
  settled.catch(() => undefined);
  return { exchange, log, settled };
}

/** A completed flow: the browser returns the code the flow handed it. */
async function completeViaBrowser(harness: LoginHarness): Promise<number> {
  const authorize = await authorizeUrlOf(harness.log);
  return deliver(callbackOf(authorize), (url) => {
    url.searchParams.set('state', stateOf(harness.log));
    url.searchParams.set('code', 'test-code');
  });
}

describe('the two entries', () => {
  it('registers both as first-class providers, separately selectable', () => {
    expect(getProvider('orcarouter').name).toBe('OrcaRouter (API key)');
    expect(getProvider('orcarouter-oauth').name).toBe('OrcaRouter (sign in)');
    expect(getProvider('orcarouter').id).not.toBe(getProvider('orcarouter-oauth').id);
  });

  it('gives both entries inference and model discovery on the same API origin', () => {
    expect(getProvider('orcarouter').models).toBeTypeOf('function');
    expect(getProvider('orcarouter-oauth').models).toBeTypeOf('function');
    expect(createApiKeyProvider({ env: {} }).id).toBe('orcarouter');
    expect(createAuthProvider({ env: {} }).id).toBe('orcarouter-oauth');
  });
});

describe('the API-key entry', () => {
  it('reads ORCAROUTER_API_KEY without asking', async () => {
    const log = recorder();
    expect(await createApiKeyProvider({ env: { ORCAROUTER_API_KEY: TEST_KEY } }).login(log.callbacks)).toEqual({ access: TEST_KEY, refresh: '', expires: 0 });
    expect(log.urls()).toEqual([]);
  });

  it('uses ORCAROUTER_API_KEY for inference without a stored login, and it beats a stored one', async () => {
    vi.stubEnv('ORCAROUTER_API_KEY', TEST_KEY);
    const provider = createApiKeyProvider({ env: process.env });
    const fetch = createOAuthFetch(provider, { store: new MemoryCredentialStore({ orcarouter: { access: 'sk-orca-stored', refresh: '', expires: 0 } }), userAgent: 'test' });
    const api = await serve((request, response) => {
      json(response, 200, { seen: request.headers['authorization'] });
    });
    const response = await fetch(`${api.url}/v1/models`);
    expect(await response.json()).toEqual({ seen: `Bearer ${TEST_KEY}` });
    vi.unstubAllEnvs();
  });

  it('reads ORCAROUTER_API_KEY with no stored login at all', async () => {
    const provider = createApiKeyProvider({ env: { ORCAROUTER_API_KEY: TEST_KEY } });
    const fetch = createOAuthFetch(provider, { store: new MemoryCredentialStore(), userAgent: 'test' });
    const api = await serve((_request, response) => json(response, 200, { ok: true }));
    expect((await fetch(`${api.url}/v1/models`)).status).toBe(200);
  });

  it('asks for a key when the environment has none, and trims what was pasted', async () => {
    const log = recorder(() => `  ${TEST_KEY}  `);
    expect(await createApiKeyProvider({ env: {} }).login(log.callbacks)).toEqual({ access: TEST_KEY, refresh: '', expires: 0 });
  });

  it('warns without rejecting when the value is not shaped like an OrcaRouter key', async () => {
    const log = recorder(() => 'some-other-key');
    expect((await createApiKeyProvider({ env: {} }).login(log.callbacks)).access).toBe('some-other-key');
    expect(log.transcript()).toContain('does not start with sk-orca-');
  });

  it('refuses an empty value', async () => {
    const log = recorder(() => '   ');
    const outcome = createApiKeyProvider({ env: {} }).login(log.callbacks);
    await expect(outcome).rejects.toMatchObject({ code: 'FLOW_FAILED' });
    await expect(outcome).rejects.not.toThrow(TEST_KEY);
  });

  it('saves, reads back, and clears through the credential store', async () => {
    const store = new MemoryCredentialStore();
    const credentials = await createApiKeyProvider({ env: { ORCAROUTER_API_KEY: TEST_KEY } }).login(recorder().callbacks);
    await store.set('orcarouter', credentials);
    expect(await store.get('orcarouter')).toEqual({ access: TEST_KEY, refresh: '', expires: 0 });
    expect(await store.list()).toEqual(['orcarouter']);
    await store.remove('orcarouter');
    expect(await store.get('orcarouter')).toBeUndefined();
  });

  it('drops a damaged stored entry, which then reads as no login rather than a broken key', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orca-store-'));
    try {
      const file = path.join(dir, 'oauth.json');
      writeFileSync(file, JSON.stringify({ orcarouter: { access: 123 }, 'orcarouter-oauth': { access: TEST_KEY, refresh: '', expires: 0 } }));
      const store = new FileCredentialStore(file);
      expect(await store.get('orcarouter')).toBeUndefined();
      expect(await store.list()).toEqual(['orcarouter-oauth']);
      const provider = createApiKeyProvider({ env: {} });
      const fetch = createOAuthFetch(provider, { store, userAgent: 'test' });
      await expect(fetch(`${API}/models`)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the sign-in entry: authorize', () => {
  it('sends a fresh S256 challenge and a fresh state per attempt', async () => {
    const first = await beginLogin();
    const second = await beginLogin();
    const a = new URL(await authorizeUrlOf(first.log)).searchParams;
    const b = new URL(await authorizeUrlOf(second.log)).searchParams;
    expect(a.get('code_challenge_method')).toBe('S256');
    expect(b.get('code_challenge_method')).toBe('S256');
    expect(a.get('code_challenge')).not.toBe(b.get('code_challenge'));
    expect(a.get('state')).not.toBe(b.get('state'));
    // 43 characters is base64url(sha256(x)) with no padding.
    expect(a.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    first.log.fail();
    second.log.fail();
  });

  it('sends only the challenge, never the verifier, and keeps the request on the auth origin', async () => {
    // The public auth origin, so the assertion is about the real URL shape, not a fake server's.
    const harness = await beginLogin({ env: { ORCA_AUTH_BASE_URL: AUTH } });
    const url = await authorizeUrlOf(harness.log);
    const parsed = new URL(url);
    expect(parsed.origin).toBe(AUTH);
    expect(parsed.pathname).toBe('/auth');
    expect(url).not.toContain('api.orcarouter.ai');
    expect(url).not.toContain(TEST_KEY);
    const params = parsed.searchParams;
    expect(params.get('app_name')).toBe('e2e');
    expect(params.get('scope')).toBe('api');
    expect(params.get('callback_url')).toMatch(/^http:\/\/localhost:\d+\/cb$/u);
    // The challenge is sent; the verifier that hashes to it is not. Only the exchange body ever holds the verifier.
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    for (const value of params.values()) expect(value).not.toContain('sk-orca-');
    harness.log.fail();
  });
});

describe('the sign-in entry: exchange', () => {
  it('completes the whole flow through the adapter and yields the shared credential', async () => {
    const harness = await beginLogin();
    expect(await completeViaBrowser(harness)).toBe(200);
    const credentials = await harness.settled;
    expect(credentials).toEqual({ access: TEST_KEY, refresh: '', expires: 0 });
    expect(harness.exchange.requests).toHaveLength(1);
    const request = harness.exchange.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/v1/auth/keys');
    const body = JSON.parse(request.body) as Record<string, string>;
    expect(body['code_challenge_method']).toBe('S256');
    expect(body['code']).toBe('test-code');
    expect(body['code_verifier']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('exchanges at /api/v1/auth/keys on the auth origin, never at /v1/auth/keys', () => {
    const origins = orcaRouterOrigins({});
    expect(exchangeUrl(origins)).toBe('https://www.orcarouter.ai/api/v1/auth/keys');
    expect(exchangeUrl(origins)).not.toContain('api.orcarouter.ai');
    // Replacing the inference origin's hostname and appending /v1 is the 404 the docs warn about.
    expect(new URL('/v1/auth/keys', 'https://api.orcarouter.ai').href).not.toBe(exchangeUrl(origins));
  });

  it('reads the granted scope and refuses a grant that cannot call the inference API', async () => {
    const harness = await beginLogin({ body: { key: TEST_KEY, user_id: '1', scope: 'connector' } });
    await completeViaBrowser(harness);
    await expect(harness.settled).rejects.toMatchObject({ code: 'FLOW_FAILED' });
    await expect(harness.settled).rejects.toThrow(/connector/u);
  });

  it('accepts the api scope, and a response that names none', async () => {
    const named = await beginLogin({ body: { key: TEST_KEY, scope: 'api' } });
    await completeViaBrowser(named);
    expect((await named.settled).access).toBe(TEST_KEY);
    const silent = await beginLogin({ body: { key: TEST_KEY } });
    await completeViaBrowser(silent);
    expect((await silent.settled).access).toBe(TEST_KEY);
  });

  it('reports a denied consent as a cancellation, not a crash', async () => {
    const harness = await beginLogin();
    const authorize = await authorizeUrlOf(harness.log);
    const status = await deliver(callbackOf(authorize), (url) => {
      url.searchParams.set('state', stateOf(harness.log));
      url.searchParams.set('error', 'access_denied');
    });
    expect(status).toBe(400);
    await expect(harness.settled).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('ignores a callback whose state does not match, and only accepts a pasted code bound to this attempt', async () => {
    const harness = await beginLogin({ timeoutMs: 250, onPrompt: (state) => `http://localhost:1/cb?code=pasted-code&state=${state}` });
    const authorize = await authorizeUrlOf(harness.log);
    const status = await deliver(callbackOf(authorize), (url) => {
      url.searchParams.set('state', 'not-the-state');
      url.searchParams.set('code', 'attacker-code');
    });
    expect(status).toBe(400);
    // The wrong-state callback is not the login; the flow falls back to the paste the state binds.
    expect((await harness.settled).access).toBe(TEST_KEY);
    expect(JSON.parse(harness.exchange.requests[0]!.body)['code']).toBe('pasted-code');
  });

  it('refuses a pasted code that belongs to a different attempt', async () => {
    const harness = await beginLogin({ timeoutMs: 1, onPrompt: () => 'http://localhost:1/cb?code=other-code&state=someone-elses-state' });
    await expect(harness.settled).rejects.toMatchObject({ code: 'FLOW_FAILED' });
    await expect(harness.settled).rejects.toThrow(/different sign-in attempt/u);
  });

  it('maps a 403 for an unknown, expired, or reused code to one actionable line', async () => {
    const harness = await beginLogin({ status: 403, body: { error: 'invalid_grant' } });
    await completeViaBrowser(harness);
    await expect(harness.settled).rejects.toMatchObject({ code: 'FLOW_FAILED' });
    await expect(harness.settled).rejects.toThrow(/unknown, expired, already used/u);
  });

  it('maps a 400 for a method mismatch to the exchange failure', async () => {
    const harness = await beginLogin({ status: 400, body: { error: 'invalid_request' } });
    await completeViaBrowser(harness);
    await expect(harness.settled).rejects.toMatchObject({ code: 'FLOW_FAILED' });
  });

  it('maps a 429 to a message that names the alternative', async () => {
    const harness = await beginLogin({ status: 429, body: { error: 'too_many_requests' } });
    await completeViaBrowser(harness);
    await expect(harness.settled).rejects.toThrow(/API key instead/u);
  });

  it('ends safely when the exchange cannot be reached', async () => {
    const harness = await beginLogin({ env: { ORCA_AUTH_BASE_URL: 'http://127.0.0.1:9' } });
    await completeViaBrowser(harness);
    await expect(harness.settled).rejects.toMatchObject({ code: 'FLOW_FAILED' });
    await expect(harness.settled).rejects.toThrow(/could not be reached/u);
  });

  it('ends safely when the exchange answers 200 without a key', async () => {
    const harness = await beginLogin({ body: { user_id: '1', scope: 'api' } });
    await completeViaBrowser(harness);
    await expect(harness.settled).rejects.toThrow(/returned no key/u);
  });

  it('binds the challenge to the verifier and never carries the verifier or the key anywhere the user sees', async () => {
    const harness = await beginLogin();
    const authorize = await authorizeUrlOf(harness.log);
    await completeViaBrowser(harness);
    const credentials = await harness.settled;
    expect(credentials.access).toBe(TEST_KEY);

    const verifier = JSON.parse(harness.exchange.requests[0]!.body)['code_verifier'] as string;
    // S256: the challenge on the authorize URL is the unpadded base64url of sha256(verifier).
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(new URL(authorize).searchParams.get('code_challenge')).toBe(challenge);

    // The verifier and the key never appear in a URL, a progress line, or an error.
    expect(harness.log.transcript()).not.toContain(TEST_KEY);
    expect(harness.log.transcript()).not.toContain(verifier);
    expect(authorize).not.toContain(verifier);
    expect(authorize).not.toContain(encodeURIComponent(verifier));
    expect(authorize).not.toContain(TEST_KEY);
  });
});

describe('the durable key is not a refresh token', () => {
  it('refuses to refresh and says the key is reused until it is revoked', async () => {
    const credentials = { access: TEST_KEY, refresh: '', expires: 0 };
    await expect(createApiKeyProvider({ env: {} }).refresh(credentials)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    await expect(createAuthProvider({ env: {} }).refresh(credentials)).rejects.toThrow(/no refresh grant/u);
  });

  it('treats a relay 401 as terminal reauthentication without ever attempting a refresh', async () => {
    let refreshed = false;
    const base = createApiKeyProvider({ env: {} });
    const provider = { ...base, refresh: (credentials: OAuthCredentials) => ((refreshed = true), base.refresh(credentials)) };
    const store = new MemoryCredentialStore({ orcarouter: { access: TEST_KEY, refresh: '', expires: 0 } });
    const api = await serve((_request, response) => json(response, 401, { error: 'invalid_api_key' }));
    const fetch = createOAuthFetch(provider, { store, userAgent: 'test', loginHint: 'run `npx e2e login orcarouter`' });
    await expect(fetch(`${api.url}/chat/completions`)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    await expect(fetch(`${api.url}/chat/completions`)).rejects.toThrow(/npx e2e login orcarouter/u);
    expect(refreshed).toBe(false);
  });

  it('lets a newer credential generation work after the old one was rejected', async () => {
    const store = new MemoryCredentialStore({ orcarouter: { access: 'sk-orca-old', refresh: '', expires: 0 } });
    const seen: string[] = [];
    const api = await serve((request, response) => {
      seen.push(request.headers['authorization'] ?? '');
      if (request.headers['authorization'] === 'Bearer sk-orca-old') return json(response, 401, { error: 'invalid_api_key' });
      json(response, 200, { ok: true });
    });
    const fetch = createOAuthFetch(createApiKeyProvider({ env: {} }), { store, userAgent: 'test' });
    await expect(fetch(`${api.url}/chat/completions`)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    await store.set('orcarouter', { access: 'sk-orca-new', refresh: '', expires: 0 });
    expect((await fetch(`${api.url}/chat/completions`)).status).toBe(200);
    expect(seen).toEqual(['Bearer sk-orca-old', 'Bearer sk-orca-new']);
  });

  it('keeps the rejected account closed until a new login replaces the key', async () => {
    const store = new MemoryCredentialStore({ orcarouter: { access: 'sk-orca-dead', refresh: '', expires: 0 } });
    let calls = 0;
    const api = await serve((_request, response) => {
      calls += 1;
      json(response, 401, { error: 'invalid_api_key' });
    });
    const fetch = createOAuthFetch(createApiKeyProvider({ env: {} }), { store, userAgent: 'test', loginHint: 'run `npx e2e login orcarouter`' });
    await expect(fetch(`${api.url}/chat/completions`)).rejects.toThrow(/rejected/u);
    // The stored secret is not deleted, but the account is unusable and the client stops calling the dead key.
    expect(await store.get('orcarouter')).toEqual({ access: 'sk-orca-dead', refresh: '', expires: 0 });
    await expect(fetch(`${api.url}/chat/completions`)).rejects.toThrow(/needs reauthentication/u);
    expect(calls).toBe(1);
  });
});

describe('one credential, two entries, no downstream difference', () => {
  it('routes both constructors to the same inference origin with the same bearer header', async () => {
    const seen: Received[] = [];
    const api = await serve((request, response) => {
      seen.push(request);
      json(response, 200, {
        id: 'c1',
        object: 'chat.completion',
        created: 1,
        model: 'orcarouter/auto',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    });
    vendor(api, { orcarouter: { access: TEST_KEY, refresh: '', expires: 0 }, 'orcarouter-oauth': { access: TEST_KEY, refresh: '', expires: 0 } });

    expect(await generateText({ model: orcarouter('orcarouter/auto'), prompt: 'hi' })).toMatchObject({ text: 'hello' });
    expect(await generateText({ model: orcarouterAuth('orcarouter/auto'), prompt: 'hi' })).toMatchObject({ text: 'hello' });

    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
    }
    expect(seen[0]!.url).toBe(seen[1]!.url);
  });

  it('constructs the same model id and provider from either entry', () => {
    expect(orcarouter('deepseek/deepseek-v4-pro').modelId).toBe(orcarouterAuth('deepseek/deepseek-v4-pro').modelId);
    expect(orcarouter('deepseek/deepseek-v4-pro').provider).toBe(orcarouterAuth('deepseek/deepseek-v4-pro').provider);
  });

  it('keeps the OrcaRouter namespace of a vendor/model id exactly as the catalog spells it', () => {
    expect(orcarouter('anthropic/claude-opus-4.8').modelId).toBe('anthropic/claude-opus-4.8');
    expect(orcarouter('orcarouter/auto').modelId).toBe('orcarouter/auto');
  });
});

describe('origins and network policy', () => {
  it('defaults to the two documented public origins', () => {
    const origins = orcaRouterOrigins({});
    expect(origins.auth).toBe(AUTH);
    expect(origins.api).toBe(API);
    expect(catalogUrl(origins)).toBe('https://api.orcarouter.ai/v1/models');
    expect(catalogUrl(origins, { capability: 'chat' })).toBe('https://api.orcarouter.ai/v1/models?capability=chat');
  });

  it('keeps the two origins independent and lets the explicit overrides win', () => {
    const split = orcaRouterOrigins({ ORCA_AUTH_BASE_URL: 'https://auth.internal.test', ORCA_API_BASE_URL: 'https://api.internal.test/v1' });
    expect(split.auth).toBe('https://auth.internal.test');
    expect(split.api).toBe('https://api.internal.test/v1');
    const shared = orcaRouterOrigins({ ORCA_BASE_URL: 'https://one.internal.test' });
    expect(shared.auth).toBe('https://one.internal.test');
    expect(shared.api).toBe('https://one.internal.test/v1');
    const both = orcaRouterOrigins({ ORCA_BASE_URL: 'https://one.internal.test', ORCA_AUTH_BASE_URL: 'https://auth.internal.test' });
    expect(both.auth).toBe('https://auth.internal.test');
    expect(both.api).toBe('https://one.internal.test/v1');
  });

  it('requires HTTPS on a remote origin and allows HTTP on loopback', () => {
    expect(orcaRouterOrigins({ ORCA_API_BASE_URL: 'http://127.0.0.1:8080/v1' }).api).toBe('http://127.0.0.1:8080/v1');
    expect(orcaRouterOrigins({ ORCA_API_BASE_URL: 'http://localhost:8080/v1' }).api).toBe('http://localhost:8080/v1');
    expect(() => orcaRouterOrigins({ ORCA_API_BASE_URL: 'http://api.internal.test/v1' })).toThrow(/HTTPS/u);
    expect(() => orcaRouterOrigins({ ORCA_AUTH_BASE_URL: 'https://user:pass@www.orcarouter.ai' })).toThrow(/userinfo/u);
    expect(() => orcaRouterOrigins({ ORCA_AUTH_BASE_URL: 'http://[bad' })).toThrow(/is not a URL/u);
  });

  it('reads an empty override as unset', () => {
    expect(orcaRouterOrigins({ ORCA_AUTH_BASE_URL: '', ORCA_BASE_URL: '' }).auth).toBe(AUTH);
  });

  it('builds the authorize URL without doubling the path', () => {
    expect(authorizeUrl(orcaRouterOrigins({}), { state: 's' })).toBe('https://www.orcarouter.ai/auth?state=s');
  });
});
