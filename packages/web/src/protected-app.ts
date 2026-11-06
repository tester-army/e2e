/**
 * Protected-preview access, scoped to the app's site: the configured headers
 * ride only requests bound for the site, and basic-auth credentials answer
 * a challenge wherever one is issued. Nothing here holds state.
 */

import { sameSite, type ResolveSecretOptions, type Secret } from 'e2e/engine';
import type { WebBasicAuth } from './options.ts';

/** The credentials the browser answers an HTTP authentication challenge with. */
export interface HttpCredential {
  readonly username: string;
  readonly password: string;
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

/** Header names lowercased, as the browser reports a request's own headers. */
export function lowercaseNames(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * The configured headers a request to `url` carries: all of them for the
 * app's site, none for any other site or when there is no site policy.
 */
export function siteHeadersFor(
  url: string | URL,
  site: string | undefined,
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined || site === undefined) return undefined;
  return sameSite(url, site) ? headers : undefined;
}

/**
 * The basic-auth credentials an attempt answers a challenge with: on a 401
 * from any origin, since a challenge is answered only where one is issued. A
 * `Secret` password resolves through the attempt, which registers the value
 * for redaction, and the `Authorization` credential the browser sends with it
 * too: a page that echoes its request headers shows that, not the password.
 */
export async function httpCredentials(
  basicAuth: WebBasicAuth,
  resolveSecret: (secret: Secret, options?: ResolveSecretOptions) => Promise<string>,
): Promise<HttpCredential> {
  const { username, password } = basicAuth;
  if (typeof password === 'string') return { username, password };
  return { username, password: await resolveSecret(password, { derived: (plaintext) => basicCredentials(username, plaintext) }) };
}

/**
 * The credential an `Authorization: Basic` header carries for `username` and
 * `password`, base64 of `username:password` as the browser encodes it, with
 * and without its `=` padding: an echo may drop or escape the padding.
 */
function basicCredentials(username: string, password: string): string[] {
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const unpadded = encoded.replace(/={1,2}$/, '');
  return unpadded === encoded ? [encoded] : [encoded, unpadded];
}
