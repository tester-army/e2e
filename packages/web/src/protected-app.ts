/**
 * Protected-preview access, scoped to exact origins: the app's own and the
 * extras the options list. The configured headers ride only requests bound
 * for one of them, and basic-auth credentials answer only a challenge one of
 * them issues. The surface calls these on every context it creates; nothing
 * here holds state.
 */

import type { BrowserContext } from 'playwright-core';
import type { ResolveSecretOptions, Secret } from 'e2e/engine';
import type { WebBasicAuth } from './surface.ts';

/** The credentials Playwright answers an HTTP authentication challenge from `origin` with. */
export interface PlaywrightHttpCredential {
  readonly username: string;
  readonly password: string;
  readonly origin: string;
}

/** An HTTP header field name: one or more `token` characters (RFC 9110). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A control character no HTTP field value may carry; a horizontal tab is the one the grammar allows. */
// oxlint-disable-next-line no-control-regex -- the control characters are the point
export const FIELD_VALUE_CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/**
 * Why the browser could not send this header, or `undefined` when it can: a
 * name outside the token grammar, a value that is not a string, or one
 * carrying a control character (a line break is a header-injection vector).
 * Config and route overrides both check headers here.
 */
export function headerProblem(name: string, value: unknown): string | undefined {
  if (!HEADER_NAME.test(name)) return `has an invalid header name: "${name}"`;
  if (typeof value !== 'string') return `header "${name}" must be a string, got ${typeof value}`;
  if (FIELD_VALUE_CONTROL.test(value)) return `header "${name}" must not contain a control character`;
  return undefined;
}

/** Header names lowercased, as Playwright reports a request's own headers. */
export function lowercaseNames(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * The origin of `url` as `URL.origin` serializes it (scheme and host
 * lowercased, a default port dropped), or `undefined` when it does not parse.
 */
function originOf(url: string | URL): string | undefined {
  try {
    return (typeof url === 'string' ? new URL(url) : url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The configured headers a request to `url` carries: all of them when its
 * origin is one of `origins`, none otherwise.
 */
export function originHeadersFor(
  url: string | URL,
  origins: ReadonlySet<string>,
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  const origin = originOf(url);
  return origin !== undefined && origins.has(origin) ? headers : undefined;
}

/**
 * Adds the configured headers to every request bound for one of `origins`,
 * via a context route that falls back to the network. A request for any
 * other origin is not routed at all. Redirect hops are never routed either:
 * Playwright carries a routed request's headers onto them, whatever origin
 * they name, and a request that started elsewhere stays without them.
 * Registered before any test route, so it
 * runs last: a test route's `fallback` reaches it, and a `continue`, which
 * skips it, merges the same headers itself (`originHeadersFor`). Nothing
 * awaits a route handler, so a fallback that fails (the page closed under
 * the request) is dropped rather than left to surface as an unhandled
 * rejection.
 */
export async function installOriginHeaders(
  context: BrowserContext,
  origins: ReadonlySet<string>,
  headers: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  if (headers === undefined || origins.size === 0) return;
  await context.route(
    (url) => originHeadersFor(url, origins, headers) !== undefined,
    async (route) => {
      await route.fallback({ headers: { ...route.request().headers(), ...headers } }).catch(() => undefined);
    },
  );
}

/**
 * The basic-auth credentials a context answers a challenge with: one
 * Playwright `httpCredentials` entry per origin in `origins`, so a `401`
 * from any other origin goes unanswered. A `Secret` password resolves
 * through the attempt, which registers the value for redaction, and the
 * `Authorization` credential Playwright sends with it too: a page that
 * echoes its request headers shows that, not the password.
 */
export async function httpCredentials(
  basicAuth: WebBasicAuth,
  origins: ReadonlySet<string>,
  resolveSecret: (secret: Secret, options?: ResolveSecretOptions) => Promise<string>,
): Promise<PlaywrightHttpCredential[]> {
  const { username, password } = basicAuth;
  const plaintext =
    typeof password === 'string' ? password : await resolveSecret(password, { derived: (value) => basicCredentials(username, value) });
  return [...origins].map((origin) => ({ username, password: plaintext, origin }));
}

/**
 * The credential an `Authorization: Basic` header carries for `username` and
 * `password`, base64 of `username:password` as Playwright encodes it, with
 * and without its `=` padding: an echo may drop or escape the padding.
 */
function basicCredentials(username: string, password: string): string[] {
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const unpadded = encoded.replace(/={1,2}$/, '');
  return unpadded === encoded ? [encoded] : [encoded, unpadded];
}

/**
 * The exact origins a credential goes to: the app's own, when the runner
 * reports one, and each extra the options list, normalized as `URL.origin`
 * serializes it. Config load has checked every extra is an origin.
 */
export function credentialOrigins(appOrigin: string | undefined, extras: readonly string[] | undefined): ReadonlySet<string> {
  return new Set([...(appOrigin === undefined ? [] : [appOrigin]), ...(extras ?? []).map((origin) => new URL(origin).origin)]);
}

/**
 * Why `value` is not an origin a credential can be scoped to, or `undefined`
 * when it is: an `http:` or `https:` URL with no user info, path, query, or
 * fragment (`https://api.example.com`, a trailing `/` allowed).
 */
export function originProblem(value: unknown): string | undefined {
  const expected = 'must be an origin such as "https://preview.example.com": an http or https URL with no path, query, or fragment';
  if (typeof value !== 'string') return `${expected}, got ${typeof value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${expected}, got "${value}"`;
  }
  const bare = url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' && !value.endsWith('?') && !value.endsWith('#');
  return (url.protocol === 'http:' || url.protocol === 'https:') && bare ? undefined : `${expected}, got "${value}"`;
}
