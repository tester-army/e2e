/**
 * The fetch an AI SDK provider is constructed with. Per request it reads the
 * stored credentials, refreshes them ahead of expiry (one refresh at a time,
 * however many calls race), replaces the SDK's key header with the bearer
 * token, lets the provider shape the request, and on a 401 refreshes once and
 * retries. Everything the vendor needs beyond a token lives in the provider.
 */

import { OAuthError } from './errors.ts';
import type { CredentialStore, FetchFunction, OAuthCredentials, OAuthProvider, PreparedRequest } from './types.ts';

export interface OAuthFetchOptions {
  readonly store: CredentialStore;
  /** The `User-Agent` sent to the vendor; name your product, never another client. */
  readonly userAgent: string;
  readonly fetch?: FetchFunction;
  /** How a missing login is described; the CLI names its own command. */
  readonly loginHint?: string;
}

const DEFAULT_SKEW_MS = 60_000;

export function createOAuthFetch(provider: OAuthProvider<never>, options: OAuthFetchOptions): FetchFunction {
  const upstream = options.fetch ?? globalThis.fetch;
  const skew = provider.refreshSkewMs ?? DEFAULT_SKEW_MS;
  let refreshing: Promise<OAuthCredentials> | undefined;

  async function current(): Promise<OAuthCredentials> {
    const stored = await options.store.get(provider.id);
    if (stored === undefined) {
      throw new OAuthError(
        'NOT_LOGGED_IN',
        `no ${provider.name} login is stored${options.loginHint === undefined ? '' : `; ${options.loginHint}`}`,
      );
    }
    return stored;
  }

  function refresh(stale: OAuthCredentials): Promise<OAuthCredentials> {
    // Another process may have rotated the refresh token already: prefer what the store holds now.
    refreshing ??= (async () => {
      const latest = (await options.store.get(provider.id)) ?? stale;
      if (latest.access !== stale.access && !expiring(latest, skew)) return latest;
      const renewed = await provider.refresh(latest);
      await options.store.set(provider.id, renewed);
      return renewed;
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function send(input: string | URL | Request, init: RequestInit | undefined, credentials: OAuthCredentials): Promise<{ response: Response; prepared: PreparedRequest }> {
    const base = new Request(input, init);
    const headers = new Headers(base.headers);
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${credentials.access}`);
    headers.set('user-agent', options.userAgent);
    const request = new Request(base, { headers });
    const prepared = provider.prepareRequest === undefined ? { request } : await provider.prepareRequest(request, credentials);
    const response = await upstream(prepared.request);
    return { response, prepared };
  }

  return async (input, init) => {
    let credentials = await current();
    if (expiring(credentials, skew)) credentials = await refresh(credentials);
    let { response, prepared } = await send(input, init, credentials);
    if (response.status === 401 && credentials.refresh !== '') {
      await response.body?.cancel();
      credentials = await refresh(credentials);
      ({ response, prepared } = await send(input, init, credentials));
    }
    return prepared.finalize === undefined ? response : prepared.finalize(response);
  };
}

/** True when the token expires within `skew` milliseconds; a token with no expiry never does. */
function expiring(credentials: OAuthCredentials, skew: number, now: number = Date.now()): boolean {
  return credentials.expires !== 0 && credentials.expires - skew <= now;
}
