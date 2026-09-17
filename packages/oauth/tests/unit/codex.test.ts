import { generateText, tool } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCredentialStore, createCodexProvider } from '../../src/index.ts';
import { chatgpt } from '../../src/chatgpt.ts';
import { extractAccountId, parseAuthorizationInput, prepareCodexRequest } from '../../src/providers/openai-codex.ts';
import { fakeJwt, json, startServer } from './helpers/server.ts';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const idToken = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123', chatgpt_compute_residency: 'eu' } });

describe('Codex login', () => {
  it('runs the browser flow: PKCE authorize URL, local callback, code exchange, account id', async () => {
    const issuer = await startServer((request, response) => {
      if (request.url === '/oauth/token') {
        const form = new URLSearchParams(request.body);
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('code')).toBe('the-code');
        expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(form.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
        json(response, 200, { access_token: 'acc', refresh_token: 'ref', id_token: idToken, expires_in: 600 });
        return;
      }
      json(response, 404, {});
    });
    servers.push(issuer);
    const provider = createCodexProvider({ issuer: issuer.url, originator: 'my-tool' });
    const credentials = await provider.login({
      onAuth(info) {
        const url = new URL(info.url);
        expect(url.origin + url.pathname).toBe(`${issuer.url}/oauth/authorize`);
        expect(url.searchParams.get('originator')).toBe('my-tool');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
        // The browser comes back to the callback server with the code and the state.
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'the-code');
        redirect.searchParams.set('state', url.searchParams.get('state')!);
        void fetch(redirect).then((r) => expect(r.status).toBe(200));
      },
      onPrompt: async () => {
        throw new Error('should not prompt');
      },
    });
    expect(credentials).toMatchObject({ access: 'acc', refresh: 'ref', accountId: 'acct_123' });
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });

  it('rejects a callback with the wrong state and falls back to a pasted code', async () => {
    const issuer = await startServer((_request, response) => json(response, 200, { access_token: 'a2', refresh_token: 'r2', id_token: idToken, expires_in: 60 }));
    servers.push(issuer);
    const provider = createCodexProvider({ issuer: issuer.url });
    const credentials = await provider.login({
      onAuth(info) {
        const url = new URL(info.url);
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'stolen');
        redirect.searchParams.set('state', 'not-ours');
        void fetch(redirect).then((r) => expect(r.status).toBe(400));
      },
      onPrompt: async () => 'pasted-code',
      onManualCodeInput: () => new Promise((resolve) => setTimeout(() => resolve(''), 50)),
    });
    expect(credentials.access).toBe('a2');
    expect(new URLSearchParams(issuer.requests.at(-1)?.body).get('code')).toBe('pasted-code');
  });

  it('parses every form the user may paste', () => {
    expect(parseAuthorizationInput('http://localhost:1455/auth/callback?code=abc&state=st')).toEqual({ code: 'abc', state: 'st' });
    expect(parseAuthorizationInput('abc#st')).toEqual({ code: 'abc', state: 'st' });
    expect(parseAuthorizationInput('code=abc&state=st')).toEqual({ code: 'abc', state: 'st' });
    expect(parseAuthorizationInput('  abc ')).toEqual({ code: 'abc' });
    expect(parseAuthorizationInput('')).toEqual({});
  });

  it('reads the account id from either token', () => {
    expect(extractAccountId({ id_token: idToken })).toBe('acct_123');
    expect(extractAccountId({ access_token: fakeJwt({ organizations: [{ id: 'org_1' }] }) })).toBe('org_1');
    expect(extractAccountId({ access_token: 'opaque' })).toBeUndefined();
  });

  it('refreshes and keeps the account id, and asks for a new login on a rejected refresh token', async () => {
    let status = 200;
    const issuer = await startServer((request, response) => {
      expect(new URLSearchParams(request.body).get('grant_type')).toBe('refresh_token');
      json(response, status, status === 200 ? { access_token: 'new', refresh_token: 'new-r', expires_in: 60 } : { error: 'invalid_grant' });
    });
    servers.push(issuer);
    const provider = createCodexProvider({ issuer: issuer.url });
    const renewed = await provider.refresh({ access: 'old', refresh: 'old-r', expires: 0, accountId: 'acct_123' });
    expect(renewed).toMatchObject({ access: 'new', refresh: 'new-r', accountId: 'acct_123' });
    status = 400;
    await expect(provider.refresh(renewed)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });
});

describe('Codex requests', () => {
  it('routes a Responses request at the Codex backend with the body the backend requires', async () => {
    const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' } });
    const original = new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: [], max_output_tokens: 100, include: ['x'] }),
    });
    const prepared = await prepareCodexRequest(original, { access, refresh: 'r', expires: 0, accountId: 'acct' }, { originator: 'e2e', apiUrl: 'https://chatgpt.com/backend-api/codex/responses' });
    expect(prepared.request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(prepared.request.headers.get('chatgpt-account-id')).toBe('acct');
    expect(prepared.request.headers.get('originator')).toBe('e2e');
    expect(prepared.request.headers.get('x-openai-internal-codex-residency')).toBe('eu');
    expect(await prepared.request.json()).toEqual({ model: 'gpt-5.5', input: [], stream: true, store: false, instructions: 'You are a helpful assistant.', include: ['x', 'reasoning.encrypted_content'] });
    expect(prepared.finalize).toBeDefined();
  });

  it('leaves a streamed request unfolded and other paths untouched', async () => {
    const streamed = new Request('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ stream: true }) });
    expect((await prepareCodexRequest(streamed, { access: 'a', refresh: 'r', expires: 0 }, { originator: 'e2e', apiUrl: 'https://c/x' })).finalize).toBeUndefined();
    const other = new Request('https://api.openai.com/v1/models');
    expect((await prepareCodexRequest(other, { access: 'a', refresh: 'r', expires: 0 }, { originator: 'e2e', apiUrl: 'https://c/x' })).request.url).toBe('https://api.openai.com/v1/models');
  });

  it('serves generateText with a forced tool call from a backend that only streams', async () => {
    const backend = await startServer((request, response) => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      expect(body['stream']).toBe(true);
      expect(body['store']).toBe(false);
      expect(request.headers['authorization']).toBe('Bearer tok');
      expect(request.headers['chatgpt-account-id']).toBe('acct_9');
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
    servers.push(backend);
    const store = new MemoryCredentialStore({ 'openai-codex': { access: 'tok', refresh: 'r', expires: 0, accountId: 'acct_9' } });
    const model = chatgpt('gpt-5.5', { store, apiUrl: `${backend.url}/codex/responses` });
    expect(model).toMatchObject({ provider: 'chatgpt.responses', modelId: 'gpt-5.5' });
    const result = await generateText({
      model,
      prompt: 'What color?',
      tools: { report: tool({ inputSchema: z.object({ color: z.string() }) }) },
      toolChoice: { type: 'tool', toolName: 'report' },
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'report', input: { color: 'red' } });
    expect(result.usage.inputTokens).toBe(10);
  });
});
