/**
 * An expired sign-in names the login command, through the constructors a
 * config calls: the login comes from `E2E_OAUTH_CREDENTIALS` and the vendor's
 * token endpoint is a local server that rejects the refresh for good.
 */

import { generateText } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { chatgpt } from '../../../src/oauth/chatgpt.ts';
import { grok } from '../../../src/oauth/grok.ts';
import { opencodeConsole } from '../../../src/oauth/opencode-console.ts';
import { json, useServers, useVendor } from './helpers/server.ts';
import { onFakeTimeouts } from './helpers/time.ts';

const serve = useServers(afterEach);
const vendor = useVendor(afterEach);

/** A login whose token lapses inside the refresh skew, so the first call refreshes before it sends anything. */
const expiring = { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 };

describe.each([
  {
    constructor: 'chatgpt',
    model: () => chatgpt('gpt-5.5'),
    id: 'openai',
    tokenPath: '/oauth/token',
    message: 'ChatGPT token request failed (401: invalid_grant); run `npx e2e login openai`',
  },
  {
    constructor: 'grok',
    model: () => grok('grok-4'),
    id: 'spacexai',
    tokenPath: '/oauth2/token',
    message: 'SpaceXAI token request failed (401: invalid_grant); run `npx e2e login spacexai`',
  },
  {
    constructor: 'opencodeConsole',
    model: () => opencodeConsole('deepseek-v4.1-flash'),
    id: 'opencode-console',
    tokenPath: '/console/auth/device/token',
    message: 'OpenCode Console token request failed (401: invalid_grant); run `npx e2e login opencode-console`',
  },
])('$constructor()', ({ model, id, tokenPath, message }) => {
  it('fails with LOGIN_REQUIRED naming the login command when the token endpoint rejects the refresh', async () => {
    const issuer = await serve((request, response) => json(response, request.url === tokenPath ? 401 : 500, { error: 'invalid_grant' }));
    vendor(issuer, { [id]: expiring });
    await expect(onFakeTimeouts(() => generateText({ model: model(), prompt: 'hi' }))).rejects.toMatchObject({ code: 'LOGIN_REQUIRED', message });
    // One refresh, no API call with the stale token, no retry.
    expect(issuer.requests.map((request) => request.url)).toEqual([tokenPath]);
    const form = new URLSearchParams(issuer.requests[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt-0');
  });
});
