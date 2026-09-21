import { generateText, tool } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCredentialStore, copilotBaseUrl, createCopilotProvider, enterpriseHost } from '../../../src/oauth/index.ts';
import { copilot } from '../../../src/oauth/copilot.ts';
import { sendCopilotRequest } from '../../../src/oauth/providers/github-copilot.ts';
import { echoUpstream, json, useServers, type Echo, type Received } from './helpers/server.ts';

const serve = useServers(afterEach);
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
    const credentials = await provider.login({ onAuth: (info) => (shown = info), onPrompt: async () => '' }, { clientId: 'Iv23_my_app', enterpriseUrl: 'https://gh.acme.com/' });
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
    const store = new MemoryCredentialStore({ 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
    const model = copilot('gpt-4.1', { store, baseURL: api.url });
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

  it('lists the chat models of the plan through the login, leaving embeddings out', async () => {
    let seen: Received | undefined;
    const api = await serve((request, response) => {
      seen = request;
      json(response, 200, {
        data: [
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'Anthropic', capabilities: { type: 'chat', supports: { tool_calls: true, vision: true } } },
          { id: 'text-embedding-3-small', name: 'Embedding', vendor: 'Azure OpenAI', capabilities: { type: 'embeddings' } },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'OpenAI', preview: true, capabilities: { type: 'chat', supports: { tool_calls: true } } },
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
    ]);
  });
});
