import { generateText, tool } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCredentialStore, copilotBaseUrl, createCopilotProvider } from '../../src/index.ts';
import { copilot } from '../../src/copilot.ts';
import { prepareCopilotRequest } from '../../src/providers/github-copilot.ts';
import { json, startServer } from './helpers/server.ts';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('Copilot login', () => {
  it('runs GitHub\'s device flow with the caller\'s OAuth App and stores a non-expiring token', async () => {
    let polls = 0;
    const github = await startServer((request, response) => {
      if (request.url === '/login/device/code') {
        expect(new URLSearchParams(request.body).get('client_id')).toBe('Iv23_my_app');
        json(response, 200, { device_code: 'dc', user_code: 'WXYZ-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0.01 });
        return;
      }
      polls += 1;
      json(response, 200, polls < 3 ? { error: 'authorization_pending' } : { access_token: 'gho_token', token_type: 'bearer', scope: 'read:user' });
    });
    servers.push(github);
    const provider = createCopilotProvider({ githubUrl: github.url });
    let shown: unknown;
    const credentials = await provider.login({ onAuth: (info) => (shown = info), onPrompt: async () => '' }, { clientId: 'Iv23_my_app' });
    expect(shown).toMatchObject({ url: 'https://github.com/login/device', userCode: 'WXYZ-1234' });
    expect(credentials).toEqual({ access: 'gho_token', refresh: '', expires: 0 });
  });

  it('explains what it needs when neither a client id nor the GitHub CLI is available', async () => {
    const provider = createCopilotProvider();
    const previousPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      await expect(provider.login({ onAuth() {}, onPrompt: async () => '' }, {})).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    } finally {
      process.env['PATH'] = previousPath;
    }
  });

  it('cannot refresh: a rejected token means signing in again', async () => {
    await expect(createCopilotProvider().refresh({ access: 'x', refresh: '', expires: 0 })).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('derives the enterprise API host', () => {
    expect(copilotBaseUrl()).toBe('https://api.githubcopilot.com');
    expect(copilotBaseUrl('https://github.acme.com/')).toBe('https://copilot-api.github.acme.com');
  });
});

describe('Copilot requests', () => {
  it('marks agent turns and image requests', async () => {
    const withImage = new Request('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }, { role: 'assistant', content: 'ok' }] }),
    });
    const prepared = await prepareCopilotRequest(withImage);
    expect(prepared.request.headers.get('x-initiator')).toBe('agent');
    expect(prepared.request.headers.get('copilot-vision-request')).toBe('true');
    expect(prepared.request.headers.get('openai-intent')).toBe('conversation-edits');
    const plain = await prepareCopilotRequest(new Request('https://api.githubcopilot.com/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }));
    expect(plain.request.headers.get('x-initiator')).toBe('user');
    expect(plain.request.headers.has('copilot-vision-request')).toBe(false);
  });

  it('serves generateText over the chat protocol with the stored GitHub token', async () => {
    const api = await startServer((request, response) => {
      expect(request.url).toBe('/chat/completions');
      expect(request.headers['authorization']).toBe('Bearer gho_x');
      expect(request.headers['copilot-vision-request']).toBe('true');
      json(response, 200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4.1',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'report', arguments: '{"color":"red"}' } }] } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
    });
    servers.push(api);
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
  });
});
