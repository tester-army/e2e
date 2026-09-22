/**
 * The fetch an AI SDK provider is constructed with. Per request it reads the
 * stored credentials, refreshes them ahead of expiry, replaces the SDK's key
 * header with the bearer token, and hands the request to the provider; on a
 * 401 it refreshes once and retries. One refresh serves every model instance
 * and every concurrent call over the same credentials, because vendors that
 * rotate refresh tokens reject the second concurrent refresh.
 */

import { OAuthError } from './errors.ts';
import type { CredentialStore, FetchFunction, OAuthCredentials, OAuthProvider } from './types.ts';

export interface OAuthFetchOptions {
  readonly store: CredentialStore;
  /** The `User-Agent` sent to the vendor; name your product, never another client. */
  readonly userAgent: string;
  readonly fetch?: FetchFunction;
  /** How a missing or expired login is fixed; the CLI names its own command. */
  readonly loginHint?: string;
}

/** Refresh this long before `expires`, so a call never starts on a token about to lapse. */
const REFRESH_SKEW_MS = 120_000;
/** After a rejected refresh token, how long to wait for another process to store the rotated one. */
const ROTATION_WAIT_MS = 500;
const ROTATION_ATTEMPTS = 4;

/**
 * Per credentials source: the refresh in flight, and credentials renewed for
 * this process when the source could not keep them (the environment store).
 * Stores over the same file share one entry, so separate model instances
 * never race each other's refresh.
 */
interface SharedState {
  readonly refreshing: Map<string, Promise<OAuthCredentials>>;
  readonly renewed: Map<string, OAuthCredentials>;
}
const byObject = new WeakMap<CredentialStore, SharedState>();
const byPath = new Map<string, SharedState>();

function sharedState(store: CredentialStore): SharedState {
  const path = (store as { readonly path?: unknown }).path;
  const map: { get(key: never): SharedState | undefined; set(key: never, value: SharedState): unknown } = typeof path === 'string' ? byPath : byObject;
  const key = (typeof path === 'string' ? path : store) as never;
  let state = map.get(key);
  if (state === undefined) map.set(key, (state = { refreshing: new Map(), renewed: new Map() }));
  return state;
}

export function createOAuthFetch<Credentials extends OAuthCredentials>(
  provider: OAuthProvider<Credentials, never>,
  options: OAuthFetchOptions,
): FetchFunction {
  const upstream = options.fetch ?? globalThis.fetch;
  const { store } = options;
  const shared = sharedState(store);

  async function current(): Promise<Credentials> {
    const stored = await store.get(provider.id);
    if (stored === undefined) {
      throw new OAuthError(
        'NOT_LOGGED_IN',
        `no ${provider.name} login is stored${options.loginHint === undefined ? '' : `; ${options.loginHint}`}`,
      );
    }
    // What this process renewed wins over a source that could not keep it; the store holds this provider's own shape.
    return (shared.renewed.get(provider.id) ?? stored) as Credentials;
  }

  async function persist(renewed: Credentials): Promise<void> {
    try {
      await store.set(provider.id, renewed);
      shared.renewed.delete(provider.id);
    } catch (cause) {
      if (!(cause instanceof OAuthError && cause.code === 'MISCONFIGURED')) throw cause;
      shared.renewed.set(provider.id, renewed);
    }
  }

  /** After a rejected refresh token: the credentials another process stored meanwhile, if any. */
  async function rotatedElsewhere(rejected: Credentials): Promise<Credentials | undefined> {
    for (let attempt = 0; attempt < ROTATION_ATTEMPTS; attempt += 1) {
      const latest = await current();
      if (latest.refresh !== rejected.refresh) return latest;
      await new Promise((resolve) => setTimeout(resolve, ROTATION_WAIT_MS));
    }
    return undefined;
  }

  function refresh(stale: Credentials): Promise<Credentials> {
    let pending = shared.refreshing.get(provider.id) as Promise<Credentials> | undefined;
    if (pending === undefined) {
      pending = (async () => {
        // Another process may have refreshed already: prefer what the store holds now.
        const latest = await current();
        if (latest.access !== stale.access && !expiring(latest)) return latest;
        try {
          const renewed = await provider.refresh(latest);
          await persist(renewed);
          return renewed;
        } catch (cause) {
          if (cause instanceof OAuthError && cause.code === 'LOGIN_REQUIRED') {
            const rotated = await rotatedElsewhere(latest);
            if (rotated !== undefined) return rotated;
            throw new OAuthError('LOGIN_REQUIRED', `${cause.message}; ${options.loginHint ?? 'sign in again'}`, { cause });
          }
          throw cause;
        }
      })().finally(() => shared.refreshing.delete(provider.id));
      shared.refreshing.set(provider.id, pending);
    }
    return pending;
  }

  return async (input, init) => {
    // Captured once so the request can be sent again after a refresh; a body stream is read here.
    const base = new Request(input, init);
    const body = base.method === 'GET' || base.method === 'HEAD' ? undefined : await base.arrayBuffer();
    const attempt = (credentials: Credentials) => {
      const headers = new Headers(base.headers);
      headers.delete('x-api-key');
      headers.set('authorization', `Bearer ${credentials.access}`);
      headers.set('user-agent', options.userAgent);
      const request = new Request(base.url, { method: base.method, headers, signal: base.signal, ...(body === undefined ? {} : { body }) });
      return provider.send === undefined ? upstream(request) : provider.send(request, credentials, upstream);
    };

    let credentials = await current();
    if (expiring(credentials)) credentials = await refresh(credentials);
    const response = await attempt(credentials);
    if (response.status !== 401 || credentials.refresh === '') return response;
    await response.body?.cancel();
    return attempt(await refresh(credentials));
  };
}

/** True when the token lapses within the skew; a token with no expiry never does. */
function expiring(credentials: OAuthCredentials): boolean {
  return credentials.expires !== 0 && credentials.expires - REFRESH_SKEW_MS <= Date.now();
}
