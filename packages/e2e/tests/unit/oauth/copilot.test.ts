import { generateText, tool } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { copilot } from '../../../src/oauth/copilot.ts';
import { copilotBaseUrl, copilotProtocolFor, createCopilotProvider, enterpriseHost, sendCopilotRequest } from '../../../src/oauth/providers/github-copilot.ts';
import { echoUpstream, json, useServers, useVendor, type Echo, type Received } from './helpers/server.ts';
import { onFakeTimeouts } from './helpers/time.ts';

const serve = useServers(afterEach);
const vendor = useVendor(afterEach);
const noCli = async () => undefined;

describe('Copilot login', () => {
  it('runs GitHub\'s device flow with the caller\'s OAuth App and stores a non-expiring token', async () => {
    let polls = 0;
    const github = await serve((request, response) => {
      if (request.url === '/login/device/code') {
        expect(new URLSearchParams(request.body).get('client_id')).toBe('Iv23_my_app');
        return json(response, 200, { device_code: 'dc', user_code: 'WXYZ-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0.001 });
      }
      expect(request.url).toBe('/login/oauth/access_token');
      const form = new URLSearchParams(request.body);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(form.get('client_id')).toBe('Iv23_my_app');
      expect(form.get('device_code')).toBe('dc');
      polls += 1;
      // GitHub answers pending with 200 and an error field.
      json(response, 200, polls < 3 ? { error: 'authorization_pending' } : { access_token: 'gho_token', token_type: 'bearer', scope: 'read:user' });
    });
    const provider = createCopilotProvider({ githubUrl: github.url, githubCliToken: noCli });
    let shown: unknown;
    const credentials = await onFakeTimeouts(() =>
      provider.login({ onAuth: (info) => (shown = info), onPrompt: async () => '' }, { clientId: 'Iv23_my_app', enterpriseUrl: 'https://gh.acme.com/' }),
    );
    expect(shown).toMatchObject({ url: 'https://github.com/login/device', userCode: 'WXYZ-1234' });
    expect(credentials).toEqual({ access: 'gho_token', refresh: '', expires: 0, enterpriseUrl: 'gh.acme.com' });
  });

  it('reuses the GitHub CLI token by default, and explains what it needs when there is none', async () => {
    const withCli = createCopilotProvider({ githubCliToken: async (hostname) => (hostname === undefined ? 'gho_cli' : undefined) });
    expect(await withCli.login({ onAuth() {}, onPrompt: async () => '' }, {})).toEqual({ access: 'gho_cli', refresh: '', expires: 0 });
    await expect(withCli.login({ onAuth() {}, onPrompt: async () => '' }, { enterpriseUrl: 'gh.acme.com' })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    await expect(withCli.login({ onAuth() {}, onPrompt: async () => '' }, { clientId: 'Iv23', fromGitHubCli: true })).resolves.toMatchObject({ access: 'gho_cli' });
    await expect(createCopilotProvider({ githubCliToken: noCli }).login({ onAuth() {}, onPrompt: async () => '' }, {})).rejects.toMatchObject({ code: 'MISCONFIGURED' });
  });

  it('cannot refresh: a rejected token means signing in again', async () => {
    await expect(createCopilotProvider().refresh({ access: 'x', refresh: '', expires: 0 })).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('derives the enterprise API host and refuses anything but a plain hostname', async () => {
    expect(copilotBaseUrl()).toBe('https://api.githubcopilot.com');
    expect(copilotBaseUrl('https://github.acme.com/')).toBe('https://copilot-api.github.acme.com');
    expect(enterpriseHost('GitHub.Acme.com')).toBe('github.acme.com');
    for (const bad of ['evil.com@github.acme.com', 'github.acme.com/path', 'github.acme.com?x=1', 'github.acme.com:8443', 'http://github.acme.com', 'not a host', 'localhost']) {
      expect(() => enterpriseHost(bad), bad).toThrow(/not a GitHub Enterprise host/);
    }
    const provider = createCopilotProvider({ githubCliToken: async () => 'gho' });
    await expect(provider.login({ onAuth() {}, onPrompt: async () => '' }, { enterpriseUrl: 'evil.com@github.acme.com' })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
  });
});

describe('Copilot requests', () => {
  it('marks agent turns and image requests, and routes an enterprise login at its host', async () => {
    const withImage = new Request('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }, { role: 'assistant', content: 'ok' }] }),
    });
    const sent = (await (await sendCopilotRequest(withImage, { access: 'a', refresh: '', expires: 0, enterpriseUrl: 'gh.acme.com' }, echoUpstream)).json()) as Echo;
    expect(sent.url).toBe('https://copilot-api.gh.acme.com/chat/completions');
    expect(sent.headers).toMatchObject({ 'x-initiator': 'agent', 'copilot-vision-request': 'true', 'openai-intent': 'conversation-edits' });
    const plain = new Request('https://api.githubcopilot.com/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
    const sentPlain = (await (await sendCopilotRequest(plain, { access: 'a', refresh: '', expires: 0 }, echoUpstream)).json()) as Echo;
    expect(sentPlain.url).toBe('https://api.githubcopilot.com/chat/completions');
    expect(sentPlain.headers['x-initiator']).toBe('user');
    expect(sentPlain.headers['copilot-vision-request']).toBeUndefined();
  });

  it('serves generateText over the chat protocol with the stored GitHub token', async () => {
    let seen: Received | undefined;
    const api = await serve((request, response) => {
      seen = request;
      json(response, 200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4.1',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'report', arguments: '{"color":"red"}' } }] } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
    });
    vendor(api, { 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
    const model = copilot('gpt-4.1');
    expect(model).toMatchObject({ provider: 'github-copilot.chat', modelId: 'gpt-4.1' });
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'color?' }, { type: 'file', data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }] }],
      tools: { report: tool({ inputSchema: z.object({ color: z.string() }) }) },
      toolChoice: { type: 'tool', toolName: 'report' },
    });
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'report', input: { color: 'red' } });
    expect(seen!.url).toBe('/chat/completions');
    expect(seen!.headers['authorization']).toBe('Bearer gho_x');
    expect(seen!.headers['copilot-vision-request']).toBe('true');
  });

  it('marks agent turns and image requests from a Responses body too', async () => {
    const withImage = new Request('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        ],
      }),
    });
    const sent = (await (await sendCopilotRequest(withImage, { access: 'a', refresh: '', expires: 0, enterpriseUrl: 'gh.acme.com' }, echoUpstream)).json()) as Echo;
    expect(sent.url).toBe('https://copilot-api.gh.acme.com/responses');
    expect(sent.headers).toMatchObject({ 'x-initiator': 'agent', 'copilot-vision-request': 'true', 'openai-intent': 'conversation-edits' });
    const plain = new Request('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
    });
    const sentPlain = (await (await sendCopilotRequest(plain, { access: 'a', refresh: '', expires: 0 }, echoUpstream)).json()) as Echo;
    expect(sentPlain.headers['x-initiator']).toBe('user');
    expect(sentPlain.headers['copilot-vision-request']).toBeUndefined();
  });

  it('names the login command when GitHub rejects the stored token, which has nothing to refresh it', async () => {
    const api = await serve((_request, response) => json(response, 401, { message: 'Bad credentials' }));
    vendor(api, { 'github-copilot': { access: 'gho_revoked', refresh: '', expires: 0 } });
    const model = copilot('gpt-4.1');
    await expect(generateText({ model, prompt: 'color?' })).rejects.toMatchObject({
      code: 'LOGIN_REQUIRED',
      message: 'GitHub Copilot rejected the stored token (401: Bad credentials); run `npx e2e login github-copilot`',
    });
    // The model listing meets the rejection first, so the call itself is never sent.
    expect(api.requests.map((request) => request.url)).toEqual(['/models']);
  });

  it('calls a model Copilot lists only over Responses through the Responses API, with no server storage', async () => {
    let seen: Received | undefined;
    const api = await serve((request, response) => {
      if (request.url === '/models') {
        json(response, 200, {
          data: [{ id: 'gpt-6-luna', vendor: 'OpenAI', supported_endpoints: ['/responses', 'ws:/responses'], capabilities: { type: 'chat' } }],
        });
        return;
      }
      seen = request;
      json(response, 200, {
        id: 'resp_1',
        created_at: 1,
        model: 'gpt-6-luna',
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'luna', annotations: [] }] }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      });
    });
    vendor(api, { 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
    const model = copilot('gpt-6-luna');
    // Before the first call the delegate reads as its chat model; the listing settles it.
    expect(model).toMatchObject({ provider: 'github-copilot.chat', modelId: 'gpt-6-luna' });
    const result = await generateText({ model, prompt: 'color?' });
    expect(result.text).toBe('luna');
    expect(model.provider).toBe('github-copilot.responses');
    expect(seen!.url).toBe('/responses');
    expect(seen!.headers['authorization']).toBe('Bearer gho_x');
    const body = JSON.parse(seen!.body) as { input?: unknown; messages?: unknown; store?: unknown };
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.messages).toBeUndefined();
    expect(body.store).toBe(false);
  });

  it('lists the chat models of the plan through the login, leaving embeddings out and marking what copilot() cannot use', async () => {
    let seen: Received | undefined;
    const api = await serve((request, response) => {
      seen = request;
      json(response, 200, {
        data: [
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'Anthropic', capabilities: { type: 'chat', supports: { tool_calls: true, vision: true } } },
          { id: 'text-embedding-3-small', name: 'Embedding', vendor: 'Azure OpenAI', capabilities: { type: 'embeddings' } },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'OpenAI', preview: true, capabilities: { type: 'chat', supports: { tool_calls: true } } },
          { id: 'claude-haiku-4.5', vendor: 'Anthropic', policy: { state: 'enabled' }, supported_endpoints: ['/chat/completions', '/v1/messages'], capabilities: { type: 'chat' } },
          { id: 'claude-opus-5', vendor: 'Anthropic', policy: { state: 'disabled' }, supported_endpoints: ['/v1/messages', '/chat/completions'], capabilities: { type: 'chat' } },
          { id: 'claude-fable-5.1', vendor: 'Anthropic', policy: { state: 'unconfigured' }, capabilities: { type: 'chat' } },
          { id: 'claude-messages', vendor: 'Anthropic', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat' } },
          { id: 'gpt-6-luna', vendor: 'OpenAI', policy: { state: 'enabled' }, supported_endpoints: ['/responses', 'ws:/responses'], capabilities: { type: 'chat' } },
          { id: 'gpt-5.5', vendor: 'OpenAI', policy: { state: 'disabled' }, supported_endpoints: ['/responses'], capabilities: { type: 'chat' } },
        ],
      });
    });
    const provider = createCopilotProvider();
    const models = await provider.models!(async (input, init) => {
      const request = new Request(input, init);
      const rerouted = new Request(request.url.replace('https://api.githubcopilot.com', api.url), request);
      return sendCopilotRequest(rerouted, { access: 'gho_x', refresh: '', expires: 0 }, fetch);
    });
    expect(seen!.url).toBe('/models');
    expect(seen!.headers['openai-intent']).toBe('conversation-edits');
    expect(models).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', detail: 'Anthropic, tools, vision' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', detail: 'OpenAI, tools, preview' },
      { id: 'claude-haiku-4.5', detail: 'Anthropic' },
      { id: 'claude-opus-5', detail: 'Anthropic, not enabled' },
      { id: 'claude-fable-5.1', detail: 'Anthropic, not enabled' },
      { id: 'claude-messages', detail: 'Anthropic, no chat or responses' },
      { id: 'gpt-6-luna', detail: 'OpenAI' },
      { id: 'gpt-5.5', detail: 'OpenAI, not enabled' },
    ]);
  });
});

describe('Copilot endpoint selection', () => {
  const signal = () => new AbortController().signal;
  const listing = (data: unknown, status = 200) => async () => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
  const entry = (supported: string[], policy?: { state: string }) => ({ id: 'm', ...(policy === undefined ? {} : { policy }), supported_endpoints: supported });

  it('reads the endpoint from the entry alone, whatever the plan policy says', async () => {
    expect(await copilotProtocolFor('m', listing([entry(['/responses', 'ws:/responses'])]), signal())).toBe('responses');
    expect(await copilotProtocolFor('m', listing([entry(['/responses'], { state: 'enabled' })]), signal())).toBe('responses');
    expect(await copilotProtocolFor('m', listing([entry(['/responses'], { state: 'disabled' })]), signal())).toBe('responses');
  });

  it('keeps chat for a model chat completions serves, one with no endpoints, and one the listing cannot place', async () => {
    const cases: Array<[string, unknown]> = [
      ['chat named', [entry(['/chat/completions', '/v1/messages'])]],
      ['chat named beside responses', [entry(['/responses', '/chat/completions'])]],
      ['no supported_endpoints', [{ id: 'm' }]],
      ['another endpoint only', [entry(['/v1/messages'])]],
      ['not in the listing', [{ id: 'other', supported_endpoints: ['/responses'] }]],
    ];
    for (const [name, data] of cases) expect(await copilotProtocolFor('m', listing(data), signal()), name).toBe('chat');
  });

  it('answers undefined when the listing cannot be read, so nothing is remembered', async () => {
    expect(await copilotProtocolFor('m', listing([entry(['/responses'])], 500), signal())).toBeUndefined();
    expect(await copilotProtocolFor('m', async () => new Response('not json'), signal())).toBeUndefined();
    expect(await copilotProtocolFor('m', async () => { throw new Error('offline'); }, signal())).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    expect(await copilotProtocolFor('m', ((request: Request) => (request.signal.aborted ? Promise.reject(new Error('aborted')) : new Promise<Response>(() => {}))) as never, aborted.signal)).toBeUndefined();
  });

  it('asks the listing again after it could not be read, then remembers the answer', async () => {
    let listings = 0;
    const api = await serve((request, response) => {
      if (request.url === '/models') {
        listings += 1;
        if (listings === 1) return json(response, 503, { message: 'busy' });
        return json(response, 200, { data: [entry(['/responses'])] });
      }
      if (request.url === '/chat/completions') return json(response, 400, { error: { message: 'model "m" is not accessible via the /chat/completions endpoint', code: 'unsupported_api_for_model' } });
      json(response, 200, { id: 'resp_1', created_at: 1, model: 'm', output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    });
    vendor(api, { 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
    const model = copilot('m');
    await expect(generateText({ model, prompt: 'x', maxRetries: 0 })).rejects.toThrow('not accessible');
    expect((await generateText({ model, prompt: 'x', maxRetries: 0 })).text).toBe('ok');
    expect((await generateText({ model, prompt: 'x', maxRetries: 0 })).text).toBe('ok');
    expect(api.requests.map((request) => request.url)).toEqual(['/models', '/chat/completions', '/models', '/responses', '/responses']);
  });

  it('lets one caller give up on the listing without failing the others waiting on it', async () => {
    let release!: () => void;
    const listed = new Promise<void>((resolve) => (release = resolve));
    const api = await serve(async (request, response) => {
      if (request.url === '/models') {
        await listed;
        return json(response, 200, { data: [{ id: 'm', supported_endpoints: ['/chat/completions'] }] });
      }
      json(response, 200, { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    });
    vendor(api, { 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
    const model = copilot('m');
    const quitter = new AbortController();
    const first = generateText({ model, prompt: 'x', maxRetries: 0, abortSignal: quitter.signal });
    const second = generateText({ model, prompt: 'x', maxRetries: 0 });
    quitter.abort(new Error('gave up'));
    await expect(first).rejects.toThrow('gave up');
    release();
    expect((await second).text).toBe('ok');
    expect(api.requests.filter((request) => request.url === '/models')).toHaveLength(1);
  });
});
