import { generateText, tool } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCredentialStore, createCodexProvider, type CodexCredentials } from '../../src/index.ts';
import { chatgpt } from '../../src/chatgpt.ts';
import { extractAccountId, parseAuthorizationInput, sendCodexRequest } from '../../src/providers/openai.ts';
import { echoUpstream, fakeJwt, json, startServer, useServers, type Echo, type Received } from './helpers/server.ts';

const serve = useServers(afterEach);

const idToken = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' } });
const accessToken = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' } });
const tokenReply = { access_token: accessToken, refresh_token: 'ref', id_token: idToken, expires_in: 600 };

/** A free port for the callback server, so the tests never contend with a real Codex login on 1455. */
async function freePort(): Promise<number> {
  const probe = await startServer(() => {});
  const port = Number(new URL(probe.url).port);
  await probe.close();
  return port;
}

/** Simulates the browser returning to the callback server with the given query. */
async function browserReturns(authorizeUrl: string, query: Record<string, string>): Promise<Response> {
  const url = new URL(authorizeUrl);
  const redirect = new URL(url.searchParams.get('redirect_uri')!);
  for (const [key, value] of Object.entries(query)) redirect.searchParams.set(key, value === '$state' ? url.searchParams.get('state')! : value);
  return fetch(redirect);
}

describe('Codex login', () => {
  it('runs the browser flow: PKCE authorize URL, local callback, code exchange, account id and residency', async () => {
    const issuer = await serve((request, response) => json(response, request.url === '/oauth/token' ? 200 : 404, tokenReply));
    const provider = createCodexProvider({ issuer: issuer.url, originator: 'my-tool', callbackPort: await freePort() });
    let authorize: URL | undefined;
    let browser: Promise<Response> | undefined;
    const credentials = await provider.login({
      onAuth(info) {
        authorize = new URL(info.url);
        browser = browserReturns(info.url, { code: 'the-code', state: '$state' });
      },
      onPrompt: async () => {
        throw new Error('should not prompt');
      },
    });
    expect((await browser!).status).toBe(200);
    expect(authorize!.origin + authorize!.pathname).toBe(`${issuer.url}/oauth/authorize`);
    expect(authorize!.searchParams.get('originator')).toBe('my-tool');
    expect(authorize!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize!.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    const exchange = new URLSearchParams(issuer.requests.find((request) => request.url === '/oauth/token')?.body);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange.get('redirect_uri')).toBe(authorize!.searchParams.get('redirect_uri'));
    expect(credentials).toMatchObject({ access: accessToken, refresh: 'ref', accountId: 'acct_123', residency: 'eu' });
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });

  it('ignores a callback with the wrong state and treats a declined sign-in as cancelled', async () => {
    const issuer = await serve((_request, response) => json(response, 200, tokenReply));
    const provider = createCodexProvider({ issuer: issuer.url, callbackPort: await freePort() });
    const statuses: Promise<number>[] = [];
    await expect(
      provider.login({
        onAuth(info) {
          statuses.push(browserReturns(info.url, { code: 'stolen', state: 'not-ours' }).then((r) => r.status));
          statuses.push(browserReturns(info.url, { error: 'x', state: 'not-ours' }).then((r) => r.status));
          statuses.push(browserReturns(info.url, { error: 'access_denied', state: '$state' }).then((r) => r.status));
        },
        onPrompt: async () => '',
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await Promise.all(statuses)).toEqual([400, 400, 400]);
    expect(issuer.requests).toHaveLength(0);
  });

  it('asks for the pasted code when the callback port is taken, and times out when the browser never returns', async () => {
    const issuer = await serve((_request, response) => json(response, 200, tokenReply));
    const port = await freePort();
    const squatter = await startServer(() => {});
    const taken = createCodexProvider({ issuer: issuer.url, callbackPort: Number(new URL(squatter.url).port) });
    try {
      const credentials = await taken.login({ onAuth() {}, onPrompt: async () => `http://localhost/auth/callback?code=pasted-code` });
      expect(credentials.access).toBe(accessToken);
      expect(new URLSearchParams(issuer.requests.at(-1)?.body).get('code')).toBe('pasted-code');
    } finally {
      await squatter.close();
    }
    const slow = createCodexProvider({ issuer: issuer.url, callbackPort: port, loginTimeoutMs: 50 });
    await expect(slow.login({ onAuth() {}, onPrompt: async () => '' })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('runs the device flow through OpenAI\'s user-code endpoints', async () => {
    let polls = 0;
    const issuer = await serve((request, response) => {
      if (request.url === '/api/accounts/deviceauth/usercode') return json(response, 200, { device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '0.001' });
      if (request.url === '/api/accounts/deviceauth/token') {
        polls += 1;
        return polls < 3 ? json(response, 403, {}) : json(response, 200, { authorization_code: 'granted-code', code_verifier: 'verifier' });
      }
      if (request.url === '/oauth/token') {
        const form = new URLSearchParams(request.body);
        expect(form.get('code')).toBe('granted-code');
        expect(form.get('code_verifier')).toBe('verifier');
        expect(form.get('redirect_uri')).toBe(`${issuer.url}/deviceauth/callback`);
        return json(response, 200, tokenReply);
      }
      json(response, 404, {});
    });
    const provider = createCodexProvider({ issuer: issuer.url });
    let shown: unknown;
    const credentials = await provider.login({ onAuth: (info) => (shown = info), onPrompt: async () => '' }, { method: 'device' });
    expect(shown).toMatchObject({ url: `${issuer.url}/codex/device`, userCode: 'ABCD-EFGH' });
    expect(credentials.accountId).toBe('acct_123');
  });

  it('parses every form the user may paste', () => {
    expect(parseAuthorizationInput('http://localhost:1455/auth/callback?code=abc&state=st')).toEqual({ code: 'abc', state: 'st' });
    expect(parseAuthorizationInput('abc#st')).toEqual({ code: 'abc', state: 'st' });
    expect(parseAuthorizationInput('code=abc&state=st')).toEqual({ code: 'abc', state: 'st' });
    expect(parseAuthorizationInput('  abc ')).toEqual({ code: 'abc', state: undefined });
    expect(parseAuthorizationInput('')).toEqual({ code: undefined, state: undefined });
  });

  it('reads the account id from either token', () => {
    expect(extractAccountId({ id_token: idToken })).toBe('acct_123');
    expect(extractAccountId({ access_token: fakeJwt({ organizations: [{ id: 'org_1' }] }) })).toBe('org_1');
    expect(extractAccountId({ access_token: 'opaque' })).toBeUndefined();
  });

  it('refreshes keeping the account id and the old refresh token when none comes back, and asks for a new login on a rejected one', async () => {
    let reply: { status: number; body: unknown } = { status: 200, body: { access_token: 'new', expires_in: 'garbage' } };
    const issuer = await serve((request, response) => {
      expect(new URLSearchParams(request.body).get('grant_type')).toBe('refresh_token');
      json(response, reply.status, reply.body);
    });
    const provider = createCodexProvider({ issuer: issuer.url });
    const renewed = await provider.refresh({ access: 'old', refresh: 'old-r', expires: 0, accountId: 'acct_123', residency: 'eu' });
    expect(renewed).toMatchObject({ access: 'new', refresh: 'old-r', accountId: 'acct_123', residency: 'eu' });
    expect(renewed.expires).toBeGreaterThan(Date.now());
    reply = { status: 400, body: { error: 'invalid_grant' } };
    await expect(provider.refresh(renewed)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });
});

describe('Codex requests', () => {
  it('routes a Responses request at the Codex backend with the body the backend requires', async () => {
    const original = new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: [], max_output_tokens: 100, include: ['x'] }),
    });
    const credentials = { access: 'a', refresh: 'r', expires: 0, accountId: 'acct', residency: 'eu' };
    const sent = (await (await sendCodexRequest(original, credentials, echoUpstream, { originator: 'e2e', apiUrl: 'https://chatgpt.com/backend-api/codex/responses' })).json()) as Echo;
    expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(sent.headers).toMatchObject({ 'chatgpt-account-id': 'acct', originator: 'e2e', 'x-openai-internal-codex-residency': 'eu' });
    expect(JSON.parse(sent.body)).toEqual({ model: 'gpt-5.5', input: [], stream: true, store: false, instructions: 'Follow the user request.', include: ['x', 'reasoning.encrypted_content'] });
  });

  it('leaves other paths untouched apart from the headers', async () => {
    const other = new Request('https://api.openai.com/v1/models');
    const sent = (await (await sendCodexRequest(other, { access: 'a', refresh: 'r', expires: 0 }, echoUpstream, { originator: 'e2e', apiUrl: 'https://c/x' })).json()) as Echo;
    expect(sent.url).toBe('https://api.openai.com/v1/models');
    expect(sent.headers).toMatchObject({ originator: 'e2e' });
  });

  it('serves generateText with a forced tool call from a backend that only streams', async () => {
    let seen: Received | undefined;
    const backend = await serve((request, response) => {
      seen = request;
      const completed = {
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-5.5',
        output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'report', arguments: '{"color":"red"}', status: 'completed' }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } })}\n\n`);
      response.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`);
      response.end();
    });
    const login: CodexCredentials = { access: 'tok', refresh: 'r', expires: 0, accountId: 'acct_9' };
    const store = new MemoryCredentialStore({ 'openai': login });
    const model = chatgpt('gpt-5.5', { store, apiUrl: `${backend.url}/codex/responses` });
    expect(model).toMatchObject({ provider: 'chatgpt.responses', modelId: 'gpt-5.5' });
    const result = await generateText({
      model,
      prompt: 'What color?',
      tools: { report: tool({ inputSchema: z.object({ color: z.string() }) }) },
      toolChoice: { type: 'tool', toolName: 'report' },
    });
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'report', input: { color: 'red' } });
    expect(result.usage.inputTokens).toBe(10);
    const body = JSON.parse(seen!.body) as Record<string, unknown>;
    expect(body['stream']).toBe(true);
    expect(body['store']).toBe(false);
    expect(seen!.headers['authorization']).toBe('Bearer tok');
    expect(seen!.headers['chatgpt-account-id']).toBe('acct_9');
  });
});
