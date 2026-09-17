import { generateText } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCredentialStore, createXaiProvider } from '../../src/index.ts';
import { grok } from '../../src/grok.ts';
import { fakeJwt, json, startServer } from './helpers/server.ts';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('xAI login', () => {
  it('runs the RFC 8628 device flow against auth.x.ai and reads expiry from the JWT', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    let polls = 0;
    const issuer = await startServer((request, response) => {
      const form = new URLSearchParams(request.body);
      if (request.url === '/oauth2/device/code') {
        expect(form.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
        expect(form.get('scope')).toContain('grok-cli:access');
        expect(form.get('referrer')).toBe('my-tool');
        json(response, 200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://accounts.x.ai/oauth2/device', verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH', expires_in: 1800, interval: 0.01 });
        return;
      }
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      polls += 1;
      if (polls === 1) json(response, 400, { error: 'authorization_pending', error_description: 'User has not yet authorized' });
      else if (polls === 2) json(response, 400, { error: 'slow_down' });
      else json(response, 200, { access_token: fakeJwt({ exp }), refresh_token: 'rt-1', expires_in: 900 });
    });
    servers.push(issuer);
    const provider = createXaiProvider({ issuer: issuer.url, referrer: 'my-tool' });
    let shown: unknown;
    const credentials = await provider.login({ onAuth: (info) => (shown = info), onPrompt: async () => '' });
    expect(shown).toMatchObject({ url: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH', userCode: 'ABCD-EFGH' });
    expect(credentials.refresh).toBe('rt-1');
    expect(credentials.expires).toBe(exp * 1000);
  });

  it('refreshes with rotation and keeps the old refresh token when none is returned', async () => {
    let rotate = true;
    const issuer = await startServer((request, response) => {
      const form = new URLSearchParams(request.body);
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe(rotate ? 'rt-1' : 'rt-2');
      json(response, 200, rotate ? { access_token: 'a2', refresh_token: 'rt-2', expires_in: 60 } : { access_token: 'a3', expires_in: 60 });
    });
    servers.push(issuer);
    const provider = createXaiProvider({ issuer: issuer.url });
    const second = await provider.refresh({ access: 'a1', refresh: 'rt-1', expires: 0 });
    expect(second).toMatchObject({ access: 'a2', refresh: 'rt-2' });
    rotate = false;
    expect(await provider.refresh(second)).toMatchObject({ access: 'a3', refresh: 'rt-2' });
  });

  it('serves generateText with the bearer token against the xAI API', async () => {
    const api = await startServer((request, response) => {
      expect(request.headers['authorization']).toBe('Bearer xai-tok');
      expect(request.headers['user-agent']).toBe('e2e-oauth');
      if (request.url.endsWith('/responses')) {
        json(response, 200, {
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'grok-4',
          output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        });
        return;
      }
      json(response, 200, {
        id: 'c1',
        object: 'chat.completion',
        created: 1,
        model: 'grok-4',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    });
    servers.push(api);
    const store = new MemoryCredentialStore({ xai: { access: 'xai-tok', refresh: 'rt', expires: 0 } });
    const model = grok('grok-4', { store, baseURL: api.url });
    expect(model).toMatchObject({ modelId: 'grok-4' });
    expect(model.provider).toMatch(/^xai/);
    const result = await generateText({ model, prompt: 'hi' });
    expect(result.text).toBe('hello');
  });
});
