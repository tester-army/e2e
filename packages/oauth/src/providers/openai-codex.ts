/**
 * ChatGPT Plus/Pro through the Codex OAuth client. The login is the one the
 * Codex CLI runs: PKCE authorization code against auth.openai.com with a
 * local callback on port 1455, or OpenAI's own user-code flow for a machine
 * without a browser. Requests then go to the Codex backend, which speaks the
 * Responses API, requires `store: false`, and answers only as a stream; the
 * stream is folded back into JSON when the SDK asked for a single response.
 */

import { startCallbackServer } from '../callback-server.ts';
import { runDeviceFlow } from '../device-code.ts';
import { OAuthError, describeResponse } from '../errors.ts';
import { decodeJwtPayload } from '../jwt.ts';
import { generatePkce, randomState } from '../pkce.ts';
import { foldResponsesStream } from '../sse.ts';
import { expiryFrom, requestTokens, type TokenResponse } from '../token-endpoint.ts';
import type { FetchFunction, OAuthCredentials, OAuthLoginCallbacks, OAuthProvider } from '../types.ts';

/** The public OAuth client of the Codex CLI, which every third-party harness signs in through. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const SCOPE = 'openid profile email offline_access';
const DEVICE_POLL_MARGIN_S = 3;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** The backend rejects a request without instructions; this is the least it accepts when the SDK sent no system prompt. */
const REQUIRED_INSTRUCTIONS = 'Follow the user request.';

export interface CodexCredentials extends OAuthCredentials {
  /** The ChatGPT account the requests bill to. */
  readonly accountId?: string;
  /** The compute residency the token pins, sent back so the backend routes accordingly. */
  readonly residency?: string;
}

export interface CodexLoginOptions {
  /** `browser` (default) opens the authorization page; `device` prints a code for another device. */
  readonly method?: 'browser' | 'device';
}

export interface CodexProviderOptions {
  /** The `originator` the authorization page and requests carry: your product's name. */
  readonly originator?: string;
  /** Test seams. */
  readonly issuer?: string;
  readonly apiUrl?: string;
  readonly callbackPort?: number;
  readonly loginTimeoutMs?: number;
}

export function createCodexProvider(options: CodexProviderOptions = {}): OAuthProvider<CodexCredentials, CodexLoginOptions> {
  const originator = options.originator ?? 'e2e';
  const issuer = options.issuer ?? ISSUER;
  const apiUrl = options.apiUrl ?? API_URL;
  const callbackPort = options.callbackPort ?? CALLBACK_PORT;
  const timeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  return {
    id: 'openai-codex',
    name: 'ChatGPT',
    async login(callbacks, loginOptions = {}) {
      const tokens =
        loginOptions.method === 'device'
          ? await deviceLogin(callbacks, issuer, timeoutMs)
          : await browserLogin(callbacks, { issuer, originator, callbackPort, timeoutMs });
      return toCredentials(tokens);
    },
    async refresh(credentials) {
      const tokens = await requestTokens(
        'ChatGPT',
        `${issuer}/oauth/token`,
        { grant_type: 'refresh_token', refresh_token: credentials.refresh, client_id: CLIENT_ID },
        'LOGIN_REQUIRED',
      );
      return toCredentials(tokens, credentials);
    },
    async send(request, credentials, upstream) {
      return sendCodexRequest(request, credentials, upstream, { originator, apiUrl });
    },
  };
}

/** Credentials from a token response; a refresh that returns no new refresh token or account keeps the previous ones. */
function toCredentials(tokens: TokenResponse, previous?: CodexCredentials): CodexCredentials {
  const accountId = extractAccountId(tokens) ?? previous?.accountId;
  const residency = extractResidency(tokens.access_token) ?? previous?.residency;
  const refresh = tokens.refresh_token ?? previous?.refresh;
  if (refresh === undefined) throw new OAuthError('FLOW_FAILED', 'the ChatGPT token response is missing refresh_token');
  return {
    access: tokens.access_token,
    refresh,
    expires: expiryFrom(tokens.expires_in),
    ...(accountId === undefined ? {} : { accountId }),
    ...(residency === undefined ? {} : { residency }),
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

function extractResidency(accessToken: string): string | undefined {
  const claims = decodeJwtPayload(accessToken);
  const nested = claims?.[AUTH_CLAIM] as Record<string, unknown> | undefined;
  const residency = nested?.['chatgpt_compute_residency'] ?? claims?.['chatgpt_compute_residency'];
  return typeof residency === 'string' && residency !== '' && residency !== 'no_constraint' ? residency : undefined;
}

/** The code from what the user pasted: a full redirect URL, `code#state`, a query string, or the bare code. */
export function parseAuthorizationInput(input: string): { code: string | undefined; state: string | undefined } {
  const value = input.trim();
  if (value === '') return { code: undefined, state: undefined };
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
  return { code: value, state: undefined };
}

function exchangeCode(issuer: string, code: string, redirectUri: string, verifier: string): Promise<TokenResponse> {
  return requestTokens('ChatGPT', `${issuer}/oauth/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
}

interface BrowserLogin {
  readonly issuer: string;
  readonly originator: string;
  readonly callbackPort: number;
  readonly timeoutMs: number;
}

async function browserLogin(callbacks: OAuthLoginCallbacks, flow: BrowserLogin): Promise<TokenResponse> {
  const { verifier, challenge } = await generatePkce();
  const state = randomState();
  const redirectUri = `http://localhost:${flow.callbackPort}${CALLBACK_PATH}`;
  const server = await startCallbackServer({ port: flow.callbackPort, path: CALLBACK_PATH, state, productName: 'ChatGPT login' });
  const url = new URL(`${flow.issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: flow.originator,
  }).toString();
  callbacks.onAuth({
    url: url.toString(),
    instructions:
      server === undefined
        ? `Port ${flow.callbackPort} is in use, so the browser cannot return here: sign in, then paste the URL the browser lands on.`
        : 'Sign in in the browser; this terminal continues when the browser returns.',
  });
  try {
    let code: string | undefined;
    if (server !== undefined) {
      const answer = await server.waitForAnswer(callbacks.signal, flow.timeoutMs);
      if ('error' in answer) {
        throw answer.error === 'access_denied'
          ? new OAuthError('CANCELLED', 'the sign-in was declined in the browser')
          : new OAuthError('FLOW_FAILED', `ChatGPT refused the sign-in: ${answer.error}`);
      }
      code = answer.code;
    } else {
      const pasted = parseAuthorizationInput(await callbacks.onPrompt({ message: 'Paste the URL the browser landed on (or the code it shows)' }));
      if (pasted.state !== undefined && pasted.state !== state) {
        throw new OAuthError('FLOW_FAILED', 'the pasted code belongs to a different login attempt; start over');
      }
      code = pasted.code;
    }
    if (code === undefined) throw new OAuthError('FLOW_FAILED', 'no authorization code was received');
    callbacks.onProgress?.('Exchanging the code for tokens');
    return await exchangeCode(flow.issuer, code, redirectUri, verifier);
  } finally {
    server?.close();
  }
}

/** The Codex CLI's device login: OpenAI's own user-code endpoints, pending until the user enters the code. */
function deviceLogin(callbacks: OAuthLoginCallbacks, issuer: string, timeoutMs: number): Promise<TokenResponse> {
  const json = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return runDeviceFlow<TokenResponse>({
    callbacks,
    async start() {
      const response = await json(`${issuer}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID });
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `ChatGPT device login could not start: ${await describeResponse(response)}`);
      const device = (await response.json()) as { device_auth_id: string; user_code: string; interval?: string | number };
      return {
        deviceCode: device.device_auth_id,
        userCode: device.user_code,
        verificationUri: `${issuer}/codex/device`,
        expiresIn: timeoutMs / 1000,
        interval: Number(device.interval) + DEVICE_POLL_MARGIN_S,
      };
    },
    async poll(authorization) {
      const response = await json(`${issuer}/api/accounts/deviceauth/token`, { device_auth_id: authorization.deviceCode, user_code: authorization.userCode });
      if (response.ok) {
        const grant = (await response.json()) as { authorization_code: string; code_verifier: string };
        return { status: 'granted', value: await exchangeCode(issuer, grant.authorization_code, `${issuer}/deviceauth/callback`, grant.code_verifier) };
      }
      // Pending shows as 403 or 404 until the user enters the code.
      if (response.status === 403 || response.status === 404) {
        await response.body?.cancel();
        return { status: 'pending' };
      }
      throw new OAuthError('FLOW_FAILED', `ChatGPT device login failed: ${await describeResponse(response)}`);
    },
  });
}

/** The Responses API body as the Codex backend wants it. */
interface CodexBody {
  stream?: boolean;
  store?: boolean;
  instructions?: string;
  include?: string[];
  max_output_tokens?: number;
  [key: string]: unknown;
}

/**
 * Routes a Responses API request at the Codex backend with the body the
 * Codex CLI sends: no server-side storage, encrypted reasoning carried
 * between turns, always streamed. A caller that did not ask for a stream gets
 * the completed response folded back into one JSON body.
 */
export async function sendCodexRequest(
  request: Request,
  credentials: CodexCredentials,
  upstream: FetchFunction,
  options: { originator: string; apiUrl: string },
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('originator', options.originator);
  if (credentials.accountId !== undefined) headers.set('chatgpt-account-id', credentials.accountId);
  if (!new URL(request.url).pathname.endsWith('/responses')) return upstream(new Request(request, { headers }));

  if (credentials.residency !== undefined) headers.set('x-openai-internal-codex-residency', credentials.residency);
  let body: CodexBody;
  try {
    body = (await request.json()) as CodexBody;
  } catch (cause) {
    throw new OAuthError('FLOW_FAILED', 'the Responses request body is not JSON', { cause });
  }
  const wantedStream = body.stream === true;
  body.stream = true;
  body.store = false;
  if (body.instructions === undefined || body.instructions === '') body.instructions = REQUIRED_INSTRUCTIONS;
  const include = body.include ?? [];
  if (!include.includes('reasoning.encrypted_content')) body.include = [...include, 'reasoning.encrypted_content'];
  // The Codex backend sizes output itself; the Codex CLI sends no cap and the backend rejects some.
  delete body.max_output_tokens;
  const response = await upstream(new Request(options.apiUrl, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal }));
  return wantedStream ? response : foldResponsesStream(response);
}
