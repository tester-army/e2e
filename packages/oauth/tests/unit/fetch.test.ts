import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvCredentialStore, FileCredentialStore, MemoryCredentialStore, OAuthError, createOAuthFetch, type OAuthCredentials, type OAuthProvider } from '../../src/index.ts';
import { json, useServers } from './helpers/server.ts';

const serve = useServers(afterEach);

type CountingProvider = OAuthProvider<OAuthCredentials, never> & { refreshes: string[] };

/** Refreshes rotate the refresh token and reject a token that was already rotated, like xAI and ChatGPT do. */
function provider(overrides: Partial<OAuthProvider<OAuthCredentials, never>> = {}): CountingProvider {
  const self: CountingProvider = {
    id: 'test',
    name: 'Test',
    refreshes: [],
    async login() {
      return { access: 'x', refresh: 'y', expires: 0 };
    },
    async refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      if (self.refreshes.includes(credentials.refresh)) throw new OAuthError('LOGIN_REQUIRED', `refresh token ${credentials.refresh} was already used`);
      self.refreshes.push(credentials.refresh);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const n = self.refreshes.length;
      return { access: `fresh-${n}`, refresh: `rt-${n}`, expires: Date.now() + 3_600_000 };
    },
    ...overrides,
  };
  return self;
}

describe('createOAuthFetch', () => {
  it('swaps the SDK key header for the bearer token and names the product', async () => {
    const api = await serve((_request, response) => json(response, 200, { ok: true }));
    const store = new MemoryCredentialStore({ test: { access: 'tok', refresh: 'r', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'my-product/1.0' });
    const response = await fetch(`${api.url}/v1/thing`, { method: 'POST', headers: { 'x-api-key': 'oauth', authorization: 'Bearer oauth' }, body: '{}' });
    expect(await response.json()).toEqual({ ok: true });
    const [request] = api.requests;
    expect(request?.headers['authorization']).toBe('Bearer tok');
    expect(request?.headers['x-api-key']).toBeUndefined();
    expect(request?.headers['user-agent']).toBe('my-product/1.0');
    expect(request?.body).toBe('{}');
  });

  it('fails with NOT_LOGGED_IN and the hint when nothing is stored', async () => {
    const fetch = createOAuthFetch(provider(), { store: new MemoryCredentialStore(), userAgent: 'p', loginHint: 'run e2e login test' });
    await expect(fetch('http://127.0.0.1:1/')).rejects.toMatchObject({ code: 'NOT_LOGGED_IN', message: expect.stringContaining('run e2e login test') });
  });

  it('refreshes an expiring token once across model instances that share a store', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 } });
    const testProvider = provider();
    const first = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    const second = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    await Promise.all([first(api.url), second(api.url), first(api.url)]);
    expect(testProvider.refreshes).toEqual(['rt-0']);
    expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1', 'Bearer fresh-1', 'Bearer fresh-1']);
    expect(await store.get('test')).toMatchObject({ access: 'fresh-1', refresh: 'rt-1' });
  });

  it('shares one refresh between separate file stores over the same file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-fetch-'));
    try {
      const file = path.join(dir, 'oauth.json');
      await new FileCredentialStore(file).set('test', { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 });
      const api = await serve((_request, response) => json(response, 200, {}));
      const testProvider = provider();
      const first = createOAuthFetch(testProvider, { store: new FileCredentialStore(file), userAgent: 'p' });
      const second = createOAuthFetch(testProvider, { store: new FileCredentialStore(file), userAgent: 'p' });
      await Promise.all([first(api.url), second(api.url)]);
      expect(testProvider.refreshes).toEqual(['rt-0']);
      expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1', 'Bearer fresh-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps credentials it renewed for a source that cannot store them', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new EnvCredentialStore(JSON.stringify({ test: { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 } }));
    const testProvider = provider();
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    await fetch(api.url);
    await fetch(api.url);
    expect(testProvider.refreshes).toEqual(['rt-0']);
    expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1', 'Bearer fresh-1']);
  });

  it('uses the credentials another process stored when its own refresh token was already rotated', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 } });
    const testProvider = provider();
    testProvider.refreshes.push('rt-0');
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    // The other process rotated the token and stores it a moment after this one was rejected.
    setTimeout(() => void store.set('test', { access: 'theirs', refresh: 'rt-1', expires: Date.now() + 3_600_000 }), 300);
    await fetch(api.url);
    expect(api.requests[0]?.headers['authorization']).toBe('Bearer theirs');
  });

  it('retries once with a refreshed token after a 401, also for a Request input', async () => {
    const api = await serve((request, response) => {
      if (request.headers['authorization'] === 'Bearer stale') json(response, 401, { error: 'expired' });
      else json(response, 200, { echo: request.body });
    });
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'p' });
    const response = await fetch(new Request(api.url, { method: 'POST', body: 'payload' }));
    expect(await response.json()).toEqual({ echo: 'payload' });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.body).toBe('payload');
  });

  it('does not retry a 401 for a token that cannot be refreshed', async () => {
    const api = await serve((_request, response) => json(response, 401, {}));
    const store = new MemoryCredentialStore({ test: { access: 'gh', refresh: '', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'p' });
    expect((await fetch(api.url)).status).toBe(401);
    expect(api.requests).toHaveLength(1);
  });

  it('lets the provider send the request its own way', async () => {
    const api = await serve((request, response) => json(response, 200, { path: request.url, marker: request.headers['x-marker'] }));
    const store = new MemoryCredentialStore({ test: { access: 'tok', refresh: '', expires: 0 } });
    const fetch = createOAuthFetch(
      provider({
        async send(request, credentials, upstream) {
          const headers = new Headers(request.headers);
          headers.set('x-marker', credentials.access);
          const response = await upstream(new Request(new URL('/rewritten', request.url), { headers }));
          return new Response(JSON.stringify({ wrapped: await response.json() }), { status: response.status });
        },
      }),
      { store, userAgent: 'p' },
    );
    expect(await (await fetch(`${api.url}/original`)).json()).toEqual({ wrapped: { path: '/rewritten', marker: 'tok' } });
  });
});
