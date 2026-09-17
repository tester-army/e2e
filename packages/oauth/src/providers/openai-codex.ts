/**
 * ChatGPT Plus/Pro through the Codex OAuth client. The login is the one the
 * Codex CLI runs: PKCE authorization code against auth.openai.com with a
 * local callback on port 1455, or a device code for a machine without a
 * browser. Requests then go to the Codex backend, which speaks the Responses
 * API, requires `store: false`, and answers only as a stream; the stream is
 * folded back into JSON when the SDK asked for a single response.
 */

import { startCallbackServer } from '../callback-server.ts';
import { abortableSleep, throwIfAborted } from '../device-code.ts';
import { OAuthError, describeResponse } from '../errors.ts';
import { decodeJwtPayload, generatePkce, randomState } from '../pkce.ts';
import { foldResponsesStream } from '../sse.ts';
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProvider, PreparedRequest } from '../types.ts';

/** The public OAuth client of the Codex CLI, which every third-party harness signs in through. */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_ISSUER = 'https://auth.openai.com';
const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const SCOPE = 'openid profile email offline_access';
const DEVICE_POLL_MARGIN_MS = 3_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export interface CodexCredentials extends OAuthCredentials {
  readonly accountId?: string;
}

export interface CodexLoginOptions {
  /** `browser` (default) opens the authorization page; `device` prints a code for another device. */
  readonly method?: 'browser' | 'device';
  /** The `originator` the authorization page and requests carry: your product's name. */
  readonly originator?: string;
  readonly issuer?: string;
}

export interface CodexProviderOptions {
  readonly originator?: string;
  readonly issuer?: string;
  readonly apiUrl?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

export function createCodexProvider(options: CodexProviderOptions = {}): OAuthProvider<CodexLoginOptions> {
  const originator = options.originator ?? 'e2e';
  const issuer = options.issuer ?? CODEX_ISSUER;
  const apiUrl = options.apiUrl ?? CODEX_API_URL;
  return {
    id: 'openai-codex',
    name: 'ChatGPT',
    async login(callbacks, loginOptions = {}) {
      const tokens =
        loginOptions.method === 'device'
          ? await deviceLogin(callbacks, loginOptions.issuer ?? issuer)
          : await browserLogin(callbacks, loginOptions.issuer ?? issuer, loginOptions.originator ?? originator);
      return toCredentials(tokens);
    },
    async refresh(credentials) {
      const response = await fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh, client_id: CODEX_CLIENT_ID }),
      });
      if (response.status === 400 || response.status === 401) {
        throw new OAuthError('LOGIN_REQUIRED', `ChatGPT rejected the refresh token (${await describeResponse(response)}); sign in again`);
      }
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `ChatGPT token refresh failed: ${await describeResponse(response)}`);
      const tokens = (await response.json()) as TokenResponse;
      const renewed = toCredentials(tokens);
      return { ...renewed, accountId: renewed.accountId ?? (credentials as CodexCredentials).accountId };
    },
    async prepareRequest(request, credentials) {
      return prepareCodexRequest(request, credentials as CodexCredentials, { originator, apiUrl });
    },
  };
}

function toCredentials(tokens: TokenResponse): CodexCredentials {
  if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    throw new OAuthError('FLOW_FAILED', 'the ChatGPT token response is missing access_token or refresh_token');
  }
  const accountId = extractAccountId(tokens);
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId === undefined ? {} : { accountId }),
  };
}

const AUTH_CLAIM = 'https://api.openai.com/auth';

function claimsOf(token: string | undefined): Record<string, unknown> | undefined {
  return token === undefined ? undefined : decodeJwtPayload(token);
}

export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  for (const claims of [claimsOf(tokens.id_token), claimsOf(tokens.access_token)]) {
    if (claims === undefined) continue;
    const nested = claims[AUTH_CLAIM] as Record<string, unknown> | undefined;
    const organizations = claims['organizations'] as Array<{ id?: unknown }> | undefined;
    const candidate = claims['chatgpt_account_id'] ?? nested?.['chatgpt_account_id'] ?? organizations?.[0]?.id;
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return undefined;
}

/** The compute residency the token pins, when it pins one. */
function extractResidency(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  const nested = claims?.[AUTH_CLAIM] as Record<string, unknown> | undefined;
  const residency = nested?.['chatgpt_compute_residency'] ?? claims?.['chatgpt_compute_residency'];
  return typeof residency === 'string' && residency !== '' && residency !== 'no_constraint' ? residency : undefined;
}

function buildAuthorizeUrl(input: { issuer: string; redirectUri: string; challenge: string; state: string; originator: string }): string {
  const url = new URL(`${input.issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: input.state,
    originator: input.originator,
  }).toString();
  return url.toString();
}

/** The code from what the user pasted: a full redirect URL, `code#state`, a query string, or the bare code. */
export function parseAuthorizationInput(input: string): { code?: string | undefined; state?: string | undefined } {
  const value = input.trim();
  if (value === '') return {};
  try {
    const url = new URL(value);
    return { code: url.searchParams.get('code') ?? undefined, state: url.searchParams.get('state') ?? undefined };
  } catch {
    // Not a URL.
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined };
  }
  return { code: value };
}

async function exchangeCode(issuer: string, code: string, redirectUri: string, verifier: string): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CODEX_CLIENT_ID, code_verifier: verifier }),
  });
  if (!response.ok) throw new OAuthError('FLOW_FAILED', `ChatGPT token exchange failed: ${await describeResponse(response)}`);
  return (await response.json()) as TokenResponse;
}

async function browserLogin(callbacks: OAuthLoginCallbacks, issuer: string, originator: string): Promise<TokenResponse> {
  const { verifier, challenge } = await generatePkce();
  const state = randomState();
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const server = await startCallbackServer({ port: CALLBACK_PORT, path: CALLBACK_PATH, state, productName: 'ChatGPT login' });
  const url = buildAuthorizeUrl({ issuer, redirectUri, challenge, state, originator });
  callbacks.onAuth({
    url,
    instructions:
      server === undefined
        ? `Port ${CALLBACK_PORT} is in use, so the browser cannot return here: sign in, then paste the URL the browser lands on.`
        : 'Sign in in the browser; this terminal continues when the browser returns.',
  });
  const abort = () => server?.cancel();
  callbacks.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, LOGIN_TIMEOUT_MS);
  try {
    let code: string | undefined;
    if (server !== undefined) {
      const manual = callbacks.onManualCodeInput?.().then((text) => ({ manual: text }));
      const raced = await Promise.race([server.waitForCode(), ...(manual === undefined ? [] : [manual])]);
      if (raced !== null && 'code' in raced) code = raced.code;
      else if (raced !== null && 'manual' in raced) code = checkState(parseAuthorizationInput(raced.manual), state);
    }
    throwIfAborted(callbacks.signal);
    if (code === undefined) {
      const pasted = await callbacks.onPrompt({ message: 'Paste the URL the browser landed on (or the code it shows)' });
      code = checkState(parseAuthorizationInput(pasted), state);
    }
    if (code === undefined) throw new OAuthError('FLOW_FAILED', 'no authorization code was received');
    callbacks.onProgress?.('Exchanging the code for tokens');
    return await exchangeCode(issuer, code, redirectUri, verifier);
  } finally {
    clearTimeout(timer);
    callbacks.signal?.removeEventListener('abort', abort);
    server?.close();
  }
}

function checkState(parsed: { code?: string | undefined; state?: string | undefined }, expected: string): string | undefined {
  if (parsed.state !== undefined && parsed.state !== expected) {
    throw new OAuthError('FLOW_FAILED', 'the pasted code belongs to a different login attempt; start over');
  }
  return parsed.code;
}

/** The Codex CLI's device login: not RFC 8628, but OpenAI's own user-code endpoints. */
async function deviceLogin(callbacks: OAuthLoginCallbacks, issuer: string): Promise<TokenResponse> {
  const started = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!started.ok) throw new OAuthError('FLOW_FAILED', `ChatGPT device login could not start: ${await describeResponse(started)}`);
  const device = (await started.json()) as { device_auth_id: string; user_code: string; interval?: string | number };
  const intervalMs = Math.max(Number(device.interval) || 5, 1) * 1000;
  callbacks.onAuth({
    url: `${issuer}/codex/device`,
    userCode: device.user_code,
    instructions: `Open ${issuer}/codex/device on any device and enter the code ${device.user_code}.`,
  });
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(callbacks.signal);
    const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    });
    if (response.ok) {
      const grant = (await response.json()) as { authorization_code: string; code_verifier: string };
      return exchangeCode(issuer, grant.authorization_code, `${issuer}/deviceauth/callback`, grant.code_verifier);
    }
    // Pending shows as 403 or 404 until the user enters the code.
    if (response.status !== 403 && response.status !== 404) {
      throw new OAuthError('FLOW_FAILED', `ChatGPT device login failed: ${await describeResponse(response)}`);
    }
    await response.body?.cancel();
    await abortableSleep(intervalMs + DEVICE_POLL_MARGIN_MS, callbacks.signal);
  }
  throw new OAuthError('TIMEOUT', 'the ChatGPT device code expired before the login finished; run the login again');
}

/**
 * Routes a Responses API request at the Codex backend. The body is what the
 * Codex CLI sends: no server-side storage, encrypted reasoning carried
 * between turns, always streamed. A caller that did not ask for a stream gets
 * the completed response folded back into one JSON body.
 */
export async function prepareCodexRequest(
  request: Request,
  credentials: CodexCredentials,
  options: { originator: string; apiUrl: string },
): Promise<PreparedRequest> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('originator', options.originator);
  if (credentials.accountId !== undefined) headers.set('chatgpt-account-id', credentials.accountId);
  const routed = url.pathname.endsWith('/responses') || url.pathname.endsWith('/chat/completions');
  if (!routed) return { request: new Request(request, { headers }) };

  const residency = extractResidency(credentials.access);
  if (residency !== undefined) headers.set('x-openai-internal-codex-residency', residency);
  const text = await request.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { request: new Request(options.apiUrl, { method: request.method, headers, body: text, signal: request.signal }) };
  }
  const wantedStream = body['stream'] === true;
  body['stream'] = true;
  body['store'] = false;
  if (typeof body['instructions'] !== 'string' || body['instructions'] === '') body['instructions'] = 'You are a helpful assistant.';
  const include = Array.isArray(body['include']) ? (body['include'] as unknown[]) : [];
  if (!include.includes('reasoning.encrypted_content')) body['include'] = [...include, 'reasoning.encrypted_content'];
  // The Codex backend sizes output itself; the Codex CLI sends no cap and the backend rejects some.
  delete body['max_output_tokens'];
  const prepared = new Request(options.apiUrl, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
  return wantedStream ? { request: prepared } : { request: prepared, finalize: foldResponsesStream };
}
