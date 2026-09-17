/**
 * The fetch an AI SDK provider is constructed with. Per request it reads the
 * stored credentials, refreshes them ahead of expiry, replaces the SDK's key
 * header with the bearer token, and hands the request to the provider; on a
 * 401 it refreshes once and retries. One refresh serves every model instance
 * and every concurrent call that shares a store, because vendors that rotate
 * refresh tokens reject the second concurrent refresh.
 */

import { OAuthError } from './errors.ts';
import type { CredentialStore, FetchFunction, OAuthCredentials, OAuthProvider } from './types.ts';

export interface OAuthFetchOptions {
  readonly store: CredentialStore;
  /** The `User-Agent` sent to the vendor; name your product, never another client. */
  readonly userAgent: string;
  readonly fetch?: FetchFunction;
  /** How a missing login is described; the CLI names its own command. */
  readonly loginHint?: string;
}

/** Refresh this long before `expires`, so a call never starts on a token about to lapse. */
const REFRESH_SKEW_MS = 120_000;

/** In-flight refreshes by store and provider id, shared by every fetch built over that store. */
const refreshing = new WeakMap<CredentialStore, Map<string, Promise<OAuthCredentials>>>();

export function createOAuthFetch<Credentials extends OAuthCredentials>(
  provider: OAuthProvider<Credentials, never>,
  options: OAuthFetchOptions,
): FetchFunction {
  const upstream = options.fetch ?? globalThis.fetch;
  const { store } = options;

  async function current(): Promise<Credentials> {
    const stored = await store.get(provider.id);
    if (stored === undefined) {
      throw new OAuthError(
        'NOT_LOGGED_IN',
        `no ${provider.name} login is stored${options.loginHint === undefined ? '' : `; ${options.loginHint}`}`,
      );
    }
    // The store holds what this provider's own login returned.
    return stored as Credentials;
  }

  function refresh(stale: Credentials): Promise<Credentials> {
    let inFlight = refreshing.get(store);
    if (inFlight === undefined) refreshing.set(store, (inFlight = new Map()));
    let pending = inFlight.get(provider.id) as Promise<Credentials> | undefined;
    if (pending === undefined) {
      pending = (async () => {
        // Another process may have refreshed already: prefer what the store holds now.
        const latest = await current();
        if (latest.access !== stale.access && !expiring(latest)) return latest;
        try {
          const renewed = await provider.refresh(latest);
          await store.set(provider.id, renewed);
          return renewed;
        } catch (cause) {
          // A rejected refresh token that another process has since rotated is not a lost login.
          if (cause instanceof OAuthError && cause.code === 'LOGIN_REQUIRED') {
            const rotated = await current();
            if (rotated.refresh !== latest.refresh) return rotated;
          }
          throw cause;
        }
      })().finally(() => inFlight!.delete(provider.id));
      inFlight.set(provider.id, pending);
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
