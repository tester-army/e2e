import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCredentialStore, createOAuthFetch, type OAuthCredentials, type OAuthProvider } from '../../src/index.ts';
import { startServer, json } from './helpers/server.ts';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

type CountingProvider = OAuthProvider<never> & { refreshes: number };

function provider(overrides: Partial<OAuthProvider<never>> = {}): CountingProvider {
  const self: CountingProvider = {
    id: 'test',
    name: 'Test',
    refreshes: 0,
    async login() {
      return { access: 'x', refresh: 'y', expires: 0 };
    },
    async refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      self.refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...credentials, access: `fresh-${self.refreshes}`, expires: Date.now() + 3_600_000 };
    },
    ...overrides,
  };
  return self;
}

describe('createOAuthFetch', () => {
  it('swaps the SDK key header for the bearer token and names the product', async () => {
    const api = await startServer((_request, response) => json(response, 200, { ok: true }));
    servers.push(api);
    const store = new MemoryCredentialStore({ test: { access: 'tok', refresh: 'r', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'my-product/1.0' });
    const response = await fetch(`${api.url}/v1/thing`, { method: 'POST', headers: { 'x-api-key': 'oauth', authorization: 'Bearer oauth' }, body: '{}' });
    expect(await response.json()).toEqual({ ok: true });
    const [request] = api.requests;
    expect(request?.headers['authorization']).toBe('Bearer tok');
    expect(request?.headers['x-api-key']).toBeUndefined();
    expect(request?.headers['user-agent']).toBe('my-product/1.0');
  });

  it('fails with NOT_LOGGED_IN and the hint when nothing is stored', async () => {
    const fetch = createOAuthFetch(provider(), { store: new MemoryCredentialStore(), userAgent: 'p', loginHint: 'run e2e login test' });
    await expect(fetch('http://127.0.0.1:1/')).rejects.toMatchObject({ code: 'NOT_LOGGED_IN', message: expect.stringContaining('run e2e login test') });
  });

  it('refreshes an expiring token once for concurrent calls and stores the result', async () => {
    const api = await startServer((_request, response) => json(response, 200, {}));
    servers.push(api);
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'r', expires: Date.now() + 1_000 } });
    const testProvider = provider();
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    await Promise.all([fetch(api.url), fetch(api.url), fetch(api.url)]);
    expect(testProvider.refreshes).toBe(1);
    expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1', 'Bearer fresh-1', 'Bearer fresh-1']);
    expect((await store.get('test'))?.access).toBe('fresh-1');
  });

  it('retries once with a refreshed token after a 401', async () => {
    const api = await startServer((request, response) => {
      if (request.headers['authorization'] === 'Bearer stale') json(response, 401, { error: 'expired' });
      else json(response, 200, { ok: true });
    });
    servers.push(api);
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'r', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'p' });
    const response = await fetch(api.url);
    expect(response.status).toBe(200);
    expect(api.requests).toHaveLength(2);
  });

  it('does not retry a 401 for a token that cannot be refreshed', async () => {
    const api = await startServer((_request, response) => json(response, 401, {}));
    servers.push(api);
    const store = new MemoryCredentialStore({ test: { access: 'gh', refresh: '', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'p' });
    expect((await fetch(api.url)).status).toBe(401);
    expect(api.requests).toHaveLength(1);
  });

  it('lets the provider reshape the request and post-process the response', async () => {
    const api = await startServer((request, response) => json(response, 200, { path: request.url, marker: request.headers['x-marker'] }));
    servers.push(api);
    const store = new MemoryCredentialStore({ test: { access: 'tok', refresh: '', expires: 0 } });
    const fetch = createOAuthFetch(
      provider({
        prepareRequest: (request) => ({
          request: new Request(new URL('/rewritten', request.url), { headers: { ...Object.fromEntries(request.headers), 'x-marker': 'yes' } }),
          finalize: async (response) => new Response(JSON.stringify({ wrapped: await response.json() }), { status: response.status }),
        }),
      }),
      { store, userAgent: 'p' },
    );
    expect(await (await fetch(`${api.url}/original`)).json()).toEqual({ wrapped: { path: '/rewritten', marker: 'yes' } });
  });
});
