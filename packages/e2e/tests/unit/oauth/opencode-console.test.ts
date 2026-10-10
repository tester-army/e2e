import { generateText, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { promptCacheKey } from '../../../src/agent/model/provider-hints.ts';
import { createOAuthFetch } from '../../../src/oauth/fetch.ts';
import { opencodeConsole } from '../../../src/oauth/opencode-console.ts';
import { listModels } from '../../../src/oauth/models.ts';
import { createOpencodeConsoleProvider } from '../../../src/oauth/providers/opencode-console.ts';
import { MemoryCredentialStore } from './helpers/store.ts';
import { json, useServers, useVendor, type Received } from './helpers/server.ts';
import { onFakeTimeouts } from './helpers/time.ts';

const serve = useServers(afterEach);
const vendor = useVendor(afterEach);

const login = { access: 'st_tok', refresh: 'rt_1', expires: Date.now() + 3_600_000, orgId: 'org_1' };

/** The v1 Console config, trimmed to what routing and the listing read. */
const config = {
  config: {
    provider: {
      opencode: {
        npm: '@ai-sdk/openai-compatible',
        api: 'https://opencode.ai/inference/openai/v1',
        models: {
          'claude-sonnet-5': { name: 'Claude Sonnet 5', cost: { input: 2, output: 10 }, modalities: { input: ['text', 'image'] }, provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/anthropic/v1' } },
          'gemini-3.1-pro': { cost: { input: 2, output: 12 }, provider: { npm: '@ai-sdk/google', api: 'https://opencode.ai/inference/google/v1beta' } },
          'gpt-5-nano': { cost: { input: 0.05, output: 0.4 }, provider: { npm: '@ai-sdk/openai' } },
          'glm-5.3': { cost: { input: 1.4, output: 4.4 } },
          'glm-5.1': { cost: { input: 1.4, output: 4.4 }, disabled: true },
          'big-pickle': { cost: { input: 0, output: 0 } },
        },
      },
      'opencode-go': {
        npm: '@ai-sdk/openai-compatible',
        api: 'https://opencode.ai/inference/go/openai/v1',
        models: { 'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', modalities: { input: ['text', 'image'] } } },
      },
      'console-anthropic': { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/custom/conn_1', models: { 'claude-opus-5-5': {} } },
    },
  },
};

const chatCompletion = { id: 'c1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };

/** A local Console and inference: the config at its path, and one canned answer per protocol. */
function workspace(answer: Partial<typeof config.config.provider> | undefined = undefined) {
  const providers = answer === undefined ? config : { config: { provider: answer } };
  return serve((request, response) => {
    if (request.url === '/console/api/config') return json(response, 200, providers);
    if (request.url.endsWith('/chat/completions')) return json(response, 200, chatCompletion);
    if (request.url.endsWith('/messages')) {
      return json(response, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } });
    }
    if (request.url.includes(':generateContent')) {
      return json(response, 200, { candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } });
    }
    if (request.url.endsWith('/responses')) {
      return json(response, 200, {
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-5-nano',
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      });
    }
    json(response, 404, { error: 'not found' });
  });
}

const inference = (requests: readonly Received[]) => requests.filter((request) => request.url.startsWith('/inference/'));

type AnthropicBody = { system: Array<{ cache_control?: unknown }>; messages: Array<{ content: Array<{ text?: string; cache_control?: unknown }> }> };

/** The texts of the message parts an Anthropic request marks as cache breakpoints. */
const markedTexts = (body: AnthropicBody) =>
  body.messages.flatMap((message) => message.content).filter((part) => part.cache_control !== undefined).map((part) => part.text);

describe('OpenCode Console login', () => {
  it('runs the device flow for a workspace-scoped login and resolves the relative verification page', async () => {
    let polls = 0;
    const consoleServer = await serve((request, response) => {
      const form = new URLSearchParams(request.body);
      expect(form.get('client_id')).toBe('e2e');
      if (request.url === '/console/auth/device/code') {
        expect(form.get('supports_org_scope')).toBe('true');
        return json(response, 200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: '/console/device', verification_uri_complete: '/console/device?user_code=ABCD-EFGH&client_id=e2e', expires_in: 600, interval: 0.001 });
      }
      expect(request.url).toBe('/console/auth/device/token');
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(form.get('device_code')).toBe('dc');
      polls += 1;
      if (polls === 1) return json(response, 400, { error: 'authorization_pending', error_description: 'The authorization request is still pending' });
      json(response, 200, { access_token: 'st_1', refresh_token: 'rt_1', token_type: 'Bearer', expires_in: 2_592_000, org_id: 'org_1' });
    });
    const provider = createOpencodeConsoleProvider({ consoleUrl: `${consoleServer.url}/console` });
    let shown: { url: string; instructions: string; userCode?: string } | undefined;
    const before = Date.now();
    const credentials = await onFakeTimeouts(() => provider.login({ onAuth: (info) => (shown = info), onPrompt: async () => '' }));
    expect(shown?.url).toBe(`${consoleServer.url}/console/device?user_code=ABCD-EFGH&client_id=e2e`);
    expect(shown?.userCode).toBe('ABCD-EFGH');
    expect(shown?.instructions).toContain(`Open ${consoleServer.url}/console/device?user_code=ABCD-EFGH&client_id=e2e`);
    expect(credentials).toMatchObject({ access: 'st_1', refresh: 'rt_1', orgId: 'org_1' });
    expect(credentials.expires).toBeGreaterThanOrEqual(before + 2_592_000_000);
  });

  it('refreshes with rotation and keeps the workspace when a grant omits it', async () => {
    const consoleServer = await serve((request, response) => {
      const form = new URLSearchParams(request.body);
      expect(request.url).toBe('/console/auth/device/token');
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_id')).toBe('e2e');
      expect(form.get('refresh_token')).toBe('rt_1');
      json(response, 200, { access_token: 'st_2', refresh_token: 'rt_2', token_type: 'Bearer', expires_in: 60 });
    });
    const provider = createOpencodeConsoleProvider({ consoleUrl: `${consoleServer.url}/console` });
    expect(await provider.refresh(login)).toMatchObject({ access: 'st_2', refresh: 'rt_2', orgId: 'org_1' });
  });

  it('keeps the refresh token when a refresh grant omits a new one', async () => {
    const consoleServer = await serve((_request, response) => json(response, 200, { access_token: 'st_2', token_type: 'Bearer', expires_in: 60 }));
    const provider = createOpencodeConsoleProvider({ consoleUrl: `${consoleServer.url}/console` });
    expect(await provider.refresh(login)).toMatchObject({ access: 'st_2', refresh: 'rt_1', orgId: 'org_1' });
  });
});

describe('opencodeConsole()', () => {
  it('routes a Zen model to the protocol the workspace config names, naming the workspace and session under one fixed name', async () => {
    const api = await workspace();
    vendor(api, { 'opencode-console': login });
    const model = opencodeConsole('claude-sonnet-5');
    expect([model.provider, model.modelId]).toEqual(['opencode', 'claude-sonnet-5']);
    const result = await generateText({ model, prompt: 'hi' });
    expect(result.text).toBe('hello');
    const [configRequest] = api.requests;
    expect(configRequest).toMatchObject({ url: '/console/api/config', headers: { authorization: 'Bearer st_tok', 'x-org-id': 'org_1' } });
    expect(configRequest!.headers).not.toHaveProperty('x-opencode-session');
    const [call] = inference(api.requests);
    expect(call!.url).toBe('/inference/anthropic/v1/messages');
    expect(call!.headers['authorization']).toBe('Bearer st_tok');
    expect(call!.headers['x-opencode-org-id']).toBe('org_1');
    expect(call!.headers['x-opencode-session']).toMatch(/^e2e_[0-9a-f-]{36}$/);
    expect(call!.headers).not.toHaveProperty('x-api-key');
    expect(call!.headers['user-agent']).toMatch(/^e2e\/\d+\.\d+\.\d+\S* \(\w+; \w+\)$/);
    expect(JSON.parse(call!.body)).toMatchObject({ model: 'claude-sonnet-5' });
    expect([model.provider, model.modelId]).toEqual(['opencode', 'claude-sonnet-5']);
  });

  it('serves Go models from the Go provider, remembering the route and keeping one session per model', async () => {
    const api = await workspace();
    vendor(api, { 'opencode-console': login });
    const model = opencodeConsole('go/deepseek-v4.1-flash');
    const providerOptions = { opencode: { reasoningEffort: 'low' } };
    await generateText({ model, prompt: 'hi', providerOptions });
    await generateText({ model, prompt: 'again' });
    await generateText({ model: opencodeConsole('go/deepseek-v4.1-flash'), prompt: 'hi' });
    const go = '/inference/go/openai/v1/chat/completions';
    expect(api.requests.map((request) => request.url)).toEqual(['/console/api/config', go, go, '/console/api/config', go]);
    const calls = inference(api.requests);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: 'deepseek-v4.1-flash', reasoning_effort: 'low' });
    const sessions = calls.map((call) => call.headers['x-opencode-session']);
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).not.toBe(sessions[0]);
    expect(model.provider).toBe('opencode.go');
  });

  it('calls Responses models without server storage under the system prompt cache key, and Google models with the bearer alone', async () => {
    const api = await workspace();
    vendor(api, { 'opencode-console': login });
    await generateText({ model: opencodeConsole('gpt-5-nano'), instructions: 'You test web apps.', prompt: 'hi' });
    await generateText({ model: opencodeConsole('gpt-5-nano'), prompt: 'hi' });
    await generateText({ model: opencodeConsole('gemini-3.1-pro'), prompt: 'hi' });
    const [responses, bare, google] = inference(api.requests);
    expect(responses!.url).toBe('/inference/openai/v1/responses');
    expect(JSON.parse(responses!.body)).toMatchObject({ model: 'gpt-5-nano', store: false, prompt_cache_key: promptCacheKey('You test web apps.') });
    expect(JSON.parse(bare!.body)).toMatchObject({ prompt_cache_key: bare!.headers['x-opencode-session'] });
    expect(google!.url).toBe('/inference/google/v1beta/models/gemini-3.1-pro:generateContent');
    expect(google!.headers['authorization']).toBe('Bearer st_tok');
    expect(google!.headers).not.toHaveProperty('x-goog-api-key');
  });

  it('marks Anthropic cache breakpoints: the system prompt, the newest message in a tool loop, none over the caller\'s own', async () => {
    const api = await workspace();
    vendor(api, { 'opencode-console': login });
    const model = opencodeConsole('claude-sonnet-5');
    await generateText({ model, instructions: 'You test web apps.', tools: { click: tool({ inputSchema: z.object({ id: z.string() }) }) }, messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'newest' }] });
    await generateText({ model, instructions: 'You judge screens.', prompt: 'Is the cart empty?' });
    await generateText({ model, instructions: { role: 'system', content: 'You test web apps.', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } }, tools: { click: tool({ inputSchema: z.object({ id: z.string() }) }) }, prompt: 'newest' });
    const [loop, judgment, placed] = inference(api.requests).map((call) => JSON.parse(call.body) as AnthropicBody);
    expect(loop!.system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(markedTexts(loop!)).toEqual(['newest']);
    expect(judgment!.system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(markedTexts(judgment!)).toEqual([]);
    expect(placed!.system.at(-1)!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(markedTexts(placed!)).toEqual([]);
  });

  it('says what to do when the login reaches no Go subscription, or the workspace does not serve the model', async () => {
    const api = await workspace({ opencode: config.config.provider.opencode });
    vendor(api, { 'opencode-console': login });
    await expect(generateText({ model: opencodeConsole('go/deepseek-v4.1-flash'), prompt: 'hi', maxRetries: 0 })).rejects.toMatchObject({
      code: 'MISCONFIGURED',
      message: expect.stringContaining('OpenCode Go is not available to this login'),
    });
    await expect(generateText({ model: opencodeConsole('glm-5.1'), prompt: 'hi', maxRetries: 0 })).rejects.toMatchObject({
      code: 'MISCONFIGURED',
      message: 'the OpenCode Console workspace does not serve glm-5.1; `npx e2e models opencode-console` lists the ids',
    });
    expect(inference(api.requests)).toEqual([]);
  });

  it('calls over chat when the config cannot be read, and asks again on the next call', async () => {
    let configs = 0;
    const api = await serve((request, response) => {
      if (request.url === '/console/api/config') {
        configs += 1;
        return configs === 1 ? json(response, 503, { error: 'down' }) : json(response, 200, config);
      }
      if (request.url.endsWith('/chat/completions')) return json(response, 200, chatCompletion);
      json(response, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } });
    });
    vendor(api, { 'opencode-console': login });
    const model = opencodeConsole('claude-sonnet-5');
    await generateText({ model, prompt: 'hi' });
    await generateText({ model, prompt: 'again' });
    expect(api.requests.map((request) => request.url)).toEqual(['/console/api/config', '/inference/openai/v1/chat/completions', '/console/api/config', '/inference/anthropic/v1/messages']);
    const [fallback, routed] = inference(api.requests);
    expect(routed!.headers['x-opencode-session']).toBe(fallback!.headers['x-opencode-session']);
  });

  it('uses OPENCODE_API_KEY in place of the stored login, a key with no workspace header to send', async () => {
    const api = await workspace();
    vendor(api, { 'opencode-console': login });
    vi.stubEnv('OPENCODE_API_KEY', ' oc_sk_env ');
    await generateText({ model: opencodeConsole('glm-5.3'), prompt: 'hi' });
    for (const request of api.requests) {
      expect(request.headers['authorization']).toBe('Bearer oc_sk_env');
      expect(request.headers).not.toHaveProperty('x-org-id');
      expect(request.headers).not.toHaveProperty('x-opencode-org-id');
    }
  });
});

describe('e2e models opencode-console', () => {
  it('lists the Zen and Go models the workspace serves, Go ids prefixed, leaving out disabled, free, and custom-provider models', async () => {
    const api = await workspace();
    const store = new MemoryCredentialStore({ 'opencode-console': login });
    const provider = createOpencodeConsoleProvider();
    vendor(api, {});
    const models = await provider.models!(createOAuthFetch(provider, { store, userAgent: 'test' }));
    expect(api.requests[0]!.headers['x-org-id']).toBe('org_1');
    expect(models).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', detail: 'Zen, $2 in, $10 out per 1M, vision' },
      { id: 'gemini-3.1-pro', detail: 'Zen, $2 in, $12 out per 1M' },
      { id: 'gpt-5-nano', detail: 'Zen, $0.05 in, $0.4 out per 1M' },
      { id: 'glm-5.3', detail: 'Zen, $1.4 in, $4.4 out per 1M' },
      { id: 'go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', detail: 'Go, vision' },
    ]);
  });

  it('lists ids through OPENCODE_API_KEY when no login is stored, the credential opencodeConsole() uses', async () => {
    const api = await workspace();
    vendor(api, {});
    vi.stubEnv('OPENCODE_API_KEY', ' oc_sk_env ');
    const models = await listModels('opencode-console', new MemoryCredentialStore());
    expect(api.requests[0]!.headers['authorization']).toBe('Bearer oc_sk_env');
    // A service key names no workspace, so there is no header to send.
    expect(api.requests[0]!.headers).not.toHaveProperty('x-org-id');
    expect(models.map((model) => model.id)).toContain('go/deepseek-v4.1-flash');
  });

  it('a stored login wins over the key, so what works today is unchanged', async () => {
    const api = await workspace();
    vendor(api, {});
    vi.stubEnv('OPENCODE_API_KEY', 'oc_sk_env');
    await listModels('opencode-console', new MemoryCredentialStore({ 'opencode-console': login }));
    expect(api.requests[0]!.headers['authorization']).toBe('Bearer st_tok');
    expect(api.requests[0]!.headers['x-org-id']).toBe('org_1');
  });

  it('with neither credential, the message names the key as well as the login', async () => {
    // No stored login, and no key in the shell: the listing fails before any request.
    vi.stubEnv('OPENCODE_API_KEY', '');
    const failure = await listModels('opencode-console', new MemoryCredentialStore()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'NOT_LOGGED_IN' });
    expect((failure as Error).message).toContain('OPENCODE_API_KEY');
  });

  it('leaves the other providers on their stored login', async () => {
    await expect(listModels('openai', new MemoryCredentialStore())).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });
});
