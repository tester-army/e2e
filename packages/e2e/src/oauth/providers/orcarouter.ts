/**
 * OrcaRouter's two credential entries. Both end with an ordinary
 * `sk-orca-…` API key belonging to the user, so both return the same
 * credential shape and neither is privileged over the other:
 *
 * - `orcarouter` — the user pastes a key they already have, or the process
 *   reads `ORCAROUTER_API_KEY`. No browser, no consent screen.
 * - `orcarouter-oauth` — OAuth 2.0 authorization code + PKCE (RFC 7636)
 *   against `www.orcarouter.ai`, which mints the key after the user approves
 *   in a browser. There is no client secret and no redirect URI to register.
 *
 * PKCE binds the authorization code to this process: only the holder of the
 * verifier can redeem it. That is what makes a public client safe. The
 * verifier is generated from a cryptographic RNG for every attempt and never
 * leaves the process until the exchange.
 *
 * The key OrcaRouter issues is durable. It is **not** a refresh token: there
 * is no refresh grant to call, and `refresh()` below says so instead of
 * pretending. `expires` is `0`, so the shared fetch never tries to renew it
 * and a relay `401` becomes terminal reauthentication.
 */

import { startCallbackServer } from '../callback-server.ts';
import { OAuthError, describeResponse } from '../errors.ts';
import { describeModels, type CatalogOptions } from '../orcarouter-catalog.ts';
import { authorizeUrl, exchangeUrl, orcaRouterOrigins, type OrcaRouterOrigins } from '../orcarouter-origins.ts';
import { generatePkce, randomState } from '../pkce.ts';
import type { FetchFunction, OAuthCredentials, OAuthLoginCallbacks, OAuthProvider, SubscriptionModel } from '../types.ts';

/** The pasted-key entry. */
export const API_KEY_PROVIDER_ID = 'orcarouter';
/** The account-login entry. */
export const AUTH_PROVIDER_ID = 'orcarouter-oauth';

/** The environment variable the pasted-key entry falls back to, named after the product. */
const API_KEY_ENV = 'ORCAROUTER_API_KEY';

/** Every OrcaRouter key starts with this; a mismatch is a warning, never proof the key is invalid. */
const KEY_PREFIX = 'sk-orca-';

/** The callback path. `callback_url` is `http://localhost:<port>/cb`. */
const CALLBACK_PATH = '/cb';

/** `oob` is the literal the consent screen hands a code back for. */
const OUT_OF_BAND_CALLBACK = 'oob';

/** The only scope that lets the returned key call the inference API. */
const DEFAULT_SCOPE = 'api';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** How the app asking for a key is named on the consent screen. */
const APP_NAME = 'e2e';

export interface OrcaRouterProviderOptions {
  /** Test seam; the process environment by default. */
  readonly env?: NodeJS.ProcessEnv;
  readonly loginTimeoutMs?: number;
  /** A test seam for the catalog request, so a listing test needs no network. */
  readonly catalog?: CatalogOptions;
}

/**
 * The pasted-key entry: a key from the environment, else asked for. The value
 * is only shape-checked, never sent anywhere to be "validated"; the first real
 * request is what establishes it.
 */
export function createApiKeyProvider(options: OrcaRouterProviderOptions = {}): OAuthProvider<OAuthCredentials, Record<string, never>> {
  const env = options.env ?? process.env;
  return {
    id: API_KEY_PROVIDER_ID,
    name: 'OrcaRouter (API key)',
    async login(callbacks) {
      const fromEnv = env[API_KEY_ENV];
      if (fromEnv !== undefined && fromEnv.trim() !== '') {
        callbacks.onProgress?.(`Using the API key in ${API_KEY_ENV}`);
        return apiKeyCredentials(checkShape(fromEnv, callbacks));
      }
      const answer = await callbacks.onPrompt({
        message: 'Paste your OrcaRouter API key (or set ORCAROUTER_API_KEY and run this again)',
        placeholder: `${KEY_PREFIX}…`,
      });
      return apiKeyCredentials(checkShape(answer, callbacks));
    },
    refresh() {
      return Promise.reject(durableKey());
    },
    environmentCredentials() {
      const fromEnv = env[API_KEY_ENV];
      return fromEnv === undefined || fromEnv.trim() === '' ? undefined : apiKeyCredentials(fromEnv.trim());
    },
    models(fetch) {
      return listOrcaRouterModels(env, options.catalog, fetch);
    },
  };
}

/**
 * The account-login entry: Flow A (loopback redirect) with an out-of-band
 * fallback. `e2e` runs on a developer machine with a browser, so the redirect
 * returns the code automatically; when the port cannot be bound, or the
 * browser never comes back, the consent screen's "show me a code" delivery is
 * exchanged instead. S256 is sent either way, because a code can always be
 * handed to a human on that screen.
 */
export function createAuthProvider(options: OrcaRouterProviderOptions = {}): OAuthProvider<OAuthCredentials, Record<string, never>> {
  const env = options.env ?? process.env;
  const timeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  return {
    id: AUTH_PROVIDER_ID,
    name: 'OrcaRouter (sign in)',
    async login(callbacks) {
      const origins = orcaRouterOrigins(env);
      const { verifier, challenge } = await generatePkce();
      const state = randomState();
      const server = await startCallbackServer({ port: 0, path: CALLBACK_PATH, state, productName: 'OrcaRouter login' });
      const url = authorizeUrl(origins, {
        callback_url: server?.redirectUri ?? OUT_OF_BAND_CALLBACK,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        app_name: APP_NAME,
        scope: DEFAULT_SCOPE,
      });
      callbacks.onAuth({
        url,
        instructions:
          server === undefined
            ? 'No local port could be bound, so the browser cannot return here: approve, then paste the code the page shows.'
            : 'Approve in the browser; this terminal continues when the browser returns, or asks for the code the page shows.',
      });
      try {
        const code = server === undefined ? await pasteCode(callbacks, state) : await answerOrPaste(server, callbacks, state, timeoutMs);
        if (code === undefined || code === '') throw new OAuthError('FLOW_FAILED', 'no authorization code was received');
        callbacks.onProgress?.('Exchanging the code for an OrcaRouter key');
        return await exchangeCode(origins, code, verifier, callbacks);
      } finally {
        server?.close();
      }
    },
    refresh() {
      return Promise.reject(durableKey());
    },
    models(fetch) {
      return listOrcaRouterModels(env, options.catalog, fetch);
    },
  };
}

/** The browser's answer; when it never comes back in time, the user pastes the code instead. */
async function answerOrPaste(server: { waitForAnswer(signal: AbortSignal | undefined, timeoutMs: number): Promise<{ code: string } | { error: string }> }, callbacks: OAuthLoginCallbacks, state: string, timeoutMs: number): Promise<string | undefined> {
  let answer: { code: string } | { error: string };
  try {
    answer = await server.waitForAnswer(callbacks.signal, timeoutMs);
  } catch (cause) {
    if (cause instanceof OAuthError && cause.code === 'TIMEOUT') return pasteCode(callbacks, state);
    throw cause;
  }
  if ('error' in answer) {
    throw answer.error === 'access_denied'
      ? new OAuthError('CANCELLED', 'the OrcaRouter sign-in was declined in the browser')
      : new OAuthError('FLOW_FAILED', `OrcaRouter refused the sign-in: ${answer.error}`);
  }
  return answer.code;
}

/** The code from what the user pasted: the bare code, a full redirect URL, or a query string. */
function parseAuthorizationInput(input: string): { code: string | undefined; state: string | undefined } {
  const value = input.trim().replace(/^["']|["']$/gu, '');
  if (value === '') return { code: undefined, state: undefined };
  try {
    const url = new URL(value);
    return { code: url.searchParams.get('code') ?? undefined, state: url.searchParams.get('state') ?? undefined };
  } catch {
    // Not a URL; the consent screen also shows a bare code.
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined };
  }
  return { code: value, state: undefined };
}

async function pasteCode(callbacks: OAuthLoginCallbacks, state: string): Promise<string | undefined> {
  const pasted = parseAuthorizationInput(await callbacks.onPrompt({ message: 'Paste the code the browser shows (or the URL it landed on)' }));
  if (pasted.state !== undefined && pasted.state !== state) {
    throw new OAuthError('FLOW_FAILED', 'the pasted code belongs to a different sign-in attempt; start again');
  }
  return pasted.code;
}

/**
 * Redeems the code. The path is `/api/v1/auth/keys` on the auth origin; the
 * inference origin never serves it. Each status gets the message the user can
 * act on, and the response body is described without ever echoing a credential.
 */
async function exchangeCode(origins: OrcaRouterOrigins, code: string, verifier: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  let response: Response;
  try {
    response = await fetch(exchangeUrl(origins), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
    });
  } catch (cause) {
    throw new OAuthError('FLOW_FAILED', `the OrcaRouter exchange could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (response.status === 403) {
    throw new OAuthError('FLOW_FAILED', 'OrcaRouter refused the code (unknown, expired, already used, or the verifier did not match); start the sign-in again');
  }
  if (response.status === 429) {
    throw new OAuthError('FLOW_FAILED', 'OrcaRouter rate-limited the sign-in (429); wait a moment and try again, or use an API key instead');
  }
  if (!response.ok) {
    throw new OAuthError('FLOW_FAILED', `the OrcaRouter exchange failed: ${await describeResponse(response)}`);
  }
  const payload = (await response.json().catch(() => undefined)) as { key?: unknown; scope?: unknown } | undefined;
  if (payload === undefined || typeof payload.key !== 'string' || payload.key === '') {
    throw new OAuthError('FLOW_FAILED', 'the OrcaRouter exchange returned no key');
  }
  // `scope` is what was granted, not what was asked for. A grant that cannot
  // call the inference API is refused rather than stored as a broken login.
  const granted = payload.scope;
  if (typeof granted === 'string' && granted !== '' && granted !== DEFAULT_SCOPE) {
    throw new OAuthError('FLOW_FAILED', `OrcaRouter granted the "${granted}" scope rather than "${DEFAULT_SCOPE}", which cannot call the inference API; ask for access to the API, or use an API key`);
  }
  return apiKeyCredentials(payload.key);
}

/**
 * The one credential both entries produce. `refresh` is empty because there is
 * no refresh grant to use, and `expires` is `0` because a durable key does not
 * lapse — not because the expiry is unknown. Nothing copies the key into a log
 * or an error: it travels only into the credential store.
 */
function apiKeyCredentials(key: string): OAuthCredentials {
  return { access: key, refresh: '', expires: 0 };
}

/** Trims the pasted value, warns once when it does not look like an OrcaRouter key, and refuses an empty one. */
function checkShape(raw: string, callbacks: OAuthLoginCallbacks): string {
  const key = raw.trim().replace(/^["']|["']$/gu, '');
  if (key === '') throw new OAuthError('FLOW_FAILED', 'no API key was given');
  if (!key.startsWith(KEY_PREFIX)) {
    callbacks.onProgress?.(`That value does not start with ${KEY_PREFIX}; storing it anyway, and the first request will say whether it works.`);
  }
  return key;
}

function durableKey(): OAuthError {
  return new OAuthError(
    'LOGIN_REQUIRED',
    'OrcaRouter issues a durable API key that is reused until it is revoked; there is no refresh grant, so sign in again or paste a new key',
  );
}

/** The chat models `e2e models` prints, read through the login's own fetch. */
function listOrcaRouterModels(env: NodeJS.ProcessEnv, catalog: CatalogOptions | undefined, fetch: FetchFunction): Promise<SubscriptionModel[]> {
  return describeModels(orcaRouterOrigins(env), { ...catalog, fetch });
}
