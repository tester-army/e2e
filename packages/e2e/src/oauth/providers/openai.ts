/**
 * ChatGPT Plus/Pro through the Codex OAuth client. The login is the one the
 * Codex CLI runs: PKCE authorization code against auth.openai.com with a
 * local callback on port 1455, or OpenAI's own user-code flow for a machine
 * without a browser. Requests then go to the Codex backend, which speaks the
 * Responses API, requires `store: false`, and answers only as a stream; the
 * stream is folded back into JSON when the SDK asked for a single response.
 */

import { z } from 'zod';
import { startCallbackServer, type CallbackAnswer, type CallbackServer } from '../callback-server.ts';
import { runDeviceFlow } from '../device-code.ts';
import { OAuthError, describeResponse, readJsonBody } from '../errors.ts';
import { decodeJwtPayload } from '../jwt.ts';
import { generatePkce, randomState } from '../pkce.ts';
import { foldResponsesStream } from '../sse.ts';
import { expiryFrom, requestTokens, type TokenResponse } from '../token-endpoint.ts';
import type { FetchFunction, OAuthCredentials, OAuthLoginCallbacks, OAuthProvider, SubscriptionModel } from '../types.ts';

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
/**
 * The model list is served per Codex CLI version: the backend hides models a
 * client is too old for. This is the Codex CLI release current when the list
 * was last checked; bump it when a model the ChatGPT app shows is missing.
 */
const CODEX_CLIENT_VERSION = '0.160.0';

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
    id: 'openai',
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
    models(fetch) {
      return listCodexModels(fetch, apiUrl);
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

export function extractAccountId(tokens: { id_token?: string | undefined; access_token?: string | undefined }): string | undefined {
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

async function exchangeCode(issuer: string, code: string, redirectUri: string, verifier: string, signal?: AbortSignal): Promise<TokenResponse> {
  try {
    return await requestTokens('ChatGPT', `${issuer}/oauth/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }, 'FLOW_FAILED', signal);
  } catch (cause) {
    if (signal?.aborted) throw new OAuthError('CANCELLED', 'the login was cancelled', { cause });
    throw cause;
  }
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
  const server = await startCallbackServer({ port: flow.callbackPort, path: CALLBACK_PATH, state, productName: 'ChatGPT login' });
  const redirectUri = server?.redirectUri ?? `http://localhost:${flow.callbackPort}${CALLBACK_PATH}`;
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
        : 'Sign in in the browser; this terminal continues when the browser returns, or asks for the URL it landed on.',
  });
  try {
    const code = server === undefined ? await pasteCode(callbacks, state) : await answerOrPaste(server, callbacks, state, flow.timeoutMs);
    if (code === undefined) throw new OAuthError('FLOW_FAILED', 'no authorization code was received');
    callbacks.onProgress?.('Exchanging the code for tokens');
    return await exchangeCode(flow.issuer, code, redirectUri, verifier, callbacks.signal);
  } finally {
    server?.close();
  }
}

/** The browser's answer; when it never comes back in time, the user pastes what it shows instead. */
async function answerOrPaste(server: CallbackServer, callbacks: OAuthLoginCallbacks, state: string, timeoutMs: number): Promise<string | undefined> {
  let answer: CallbackAnswer;
  try {
    answer = await server.waitForAnswer(callbacks.signal, timeoutMs);
  } catch (cause) {
    if (cause instanceof OAuthError && cause.code === 'TIMEOUT') return pasteCode(callbacks, state);
    throw cause;
  }
  if ('error' in answer) {
    throw answer.error === 'access_denied'
      ? new OAuthError('CANCELLED', 'the sign-in was declined in the browser')
      : new OAuthError('FLOW_FAILED', `ChatGPT refused the sign-in: ${answer.error}`);
  }
  return answer.code;
}

async function pasteCode(callbacks: OAuthLoginCallbacks, state: string): Promise<string | undefined> {
  const pasted = parseAuthorizationInput(await callbacks.onPrompt({ message: 'Paste the URL the browser landed on (or the code it shows)' }));
  if (pasted.state !== undefined && pasted.state !== state) {
    throw new OAuthError('FLOW_FAILED', 'the pasted code belongs to a different login attempt; start over');
  }
  return pasted.code;
}

/** OpenAI's user-code answer: the code to show and the id the poll names it by. */
const UserCodeSchema = z.object({
  device_auth_id: z.string(),
  user_code: z.string(),
  interval: z.unknown().optional(),
});

/** OpenAI's answer once the user entered the code: an authorization code and the PKCE verifier to exchange it with. */
const DeviceGrantSchema = z.object({
  authorization_code: z.string(),
  code_verifier: z.string(),
});

/** The Codex CLI's device login: OpenAI's own user-code endpoints, pending until the user enters the code. */
function deviceLogin(callbacks: OAuthLoginCallbacks, issuer: string, timeoutMs: number): Promise<TokenResponse> {
  const json = (url: string, body: unknown, signal?: AbortSignal) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
  return runDeviceFlow<TokenResponse>({
    callbacks,
    async start(signal) {
      const response = await json(`${issuer}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID }, signal);
      if (!response.ok) throw new OAuthError('FLOW_FAILED', `ChatGPT device login could not start: ${await describeResponse(response)}`);
      const device = await readJsonBody(response, UserCodeSchema, 'the ChatGPT device code response', 'is missing fields');
      return {
        deviceCode: device.device_auth_id,
        userCode: device.user_code,
        verificationUri: `${issuer}/codex/device`,
        expiresIn: timeoutMs / 1000,
        interval: Number(device.interval) + DEVICE_POLL_MARGIN_S,
      };
    },
    async poll(authorization, signal) {
      const response = await json(`${issuer}/api/accounts/deviceauth/token`, { device_auth_id: authorization.deviceCode, user_code: authorization.userCode }, signal);
      if (response.ok) {
        const grant = await readJsonBody(response, DeviceGrantSchema, 'the ChatGPT device grant', 'is missing fields');
        return { status: 'granted', value: await exchangeCode(issuer, grant.authorization_code, `${issuer}/deviceauth/callback`, grant.code_verifier, signal) };
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

/** A Responses API body, as far as the Codex backend needs it changed; every other field passes through. */
const CodexBodySchema = z.looseObject({
  stream: z.unknown().optional(),
  store: z.unknown().optional(),
  instructions: z.unknown().optional(),
  include: z.array(z.unknown()).nullish(),
  max_output_tokens: z.unknown().optional(),
});

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
  const body = await readJsonBody(request, CodexBodySchema, 'the Responses request body');
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

/** A reasoning level the Codex backend names bare or as `{ effort }`; one of another shape reads as absent. */
const ReasoningLevelSchema = z
  .union([z.string(), z.object({ effort: z.string() }).transform(({ effort }) => effort)])
  .optional()
  .catch(undefined);

/** One entry of the Codex backend's model list, as far as the listing reads it; a field of another type reads as absent. */
const CodexModelSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().optional().catch(undefined),
  visibility: z.unknown().optional(),
  default_reasoning_level: z.string().optional().catch(undefined),
  supported_reasoning_levels: z.array(ReasoningLevelSchema).optional().catch(undefined),
  priority: z.number().optional().catch(undefined),
});

/** The models in the Codex backend's `/models` body; a body that names none has none, and an entry without a slug is left out. */
const CodexModelListSchema = z
  .object({ models: z.array(CodexModelSchema.optional().catch(undefined)).nullish() })
  .transform(({ models }) => (models ?? []).filter((model) => model !== undefined));

/**
 * The models the Codex backend serves this subscription, `/models` next to
 * `/responses`. Hidden ones are listed too, marked, because the backend
 * still serves them.
 */
async function listCodexModels(fetch: FetchFunction, apiUrl: string): Promise<SubscriptionModel[]> {
  if (!apiUrl.endsWith('/responses')) throw new OAuthError('MISCONFIGURED', `the Codex API URL must end in /responses to list models next to it; got ${apiUrl}`);
  const url = new URL(`${apiUrl.slice(0, -'/responses'.length)}/models`);
  url.searchParams.set('client_version', CODEX_CLIENT_VERSION);
  const response = await fetch(url);
  if (!response.ok) throw new OAuthError('FLOW_FAILED', `ChatGPT did not list its models: ${await describeResponse(response)}`);
  const models = await readJsonBody(response, CodexModelListSchema, 'the ChatGPT model list');
  return models
    .toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((model) => {
      const levels = (model.supported_reasoning_levels ?? []).filter((level) => level !== undefined);
      const detail = [
        levels.length === 0 ? undefined : `reasoning ${levels.join('/')}${model.default_reasoning_level === undefined ? '' : ` (default ${model.default_reasoning_level})`}`,
        model.visibility === 'hide' ? 'hidden in Codex' : undefined,
      ].filter((part) => part !== undefined);
      return {
        id: model.slug,
        ...(model.display_name === undefined || model.display_name === '' ? {} : { name: model.display_name }),
        ...(detail.length === 0 ? {} : { detail: detail.join('; ') }),
      };
    });
}
