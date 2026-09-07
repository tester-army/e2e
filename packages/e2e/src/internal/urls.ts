/** URL normalization and origin policy helpers (spec 05-config.md). */

import { ConfigurationError } from './errors.ts';
import { testPattern } from './regexp.ts';

export interface NormalizedBaseUrl {
  /** Serialized base URL without trailing artifacts beyond the normalized path. */
  readonly href: string;
  readonly origin: string;
  readonly basePath: string;
}

/**
 * Parses and normalizes the app base URL. Rejects userinfo, query, and
 * fragment. WHATWG parsing handles IDNA ASCII hosts, dot segments, and
 * default-port removal. A URL without a scheme gets `https://`, or `http://`
 * for a loopback host, so `tester.army` and `localhost:3000` both work as-is.
 */
export function normalizeBaseUrl(raw: string): NormalizedBaseUrl {
  let url: URL;
  try {
    url = new URL(withScheme(raw));
  } catch {
    throw new ConfigurationError('INVALID_APP_URL', `invalid app URL: ${raw}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigurationError('INVALID_APP_URL', 'app URL must not contain userinfo');
  }
  if (url.search !== '') {
    throw new ConfigurationError('INVALID_APP_URL', 'app URL must not contain a query');
  }
  if (url.hash !== '') {
    throw new ConfigurationError('INVALID_APP_URL', 'app URL must not contain a fragment');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigurationError('INVALID_APP_URL', `app URL must be http(s): ${raw}`);
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new ConfigurationError(
      'INVALID_APP_URL',
      `plain HTTP is allowed only for loopback hosts: ${raw}`,
    );
  }
  return { href: url.href, origin: url.origin, basePath: url.pathname };
}

/**
 * Prepends a scheme to a schemeless URL. `localhost:3000` parses as scheme
 * `localhost:` under WHATWG rules, so a `scheme:` prefix counts as explicit
 * only when what follows the colon is not a port (`file:/tmp/app` stays a
 * file URL and is rejected downstream; `localhost:3000/app` is a host). The
 * loopback check runs on the host the string would have under a scheme.
 */
function withScheme(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(raw)) return raw;
  let probe: URL;
  try {
    probe = new URL(`https://${raw}`);
  } catch {
    return raw;
  }
  return `${isLoopbackHost(probe.hostname) ? 'http' : 'https'}://${raw}`;
}

/** True for loopback hosts where plain HTTP is allowed. */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  if (/^127(\.\d{1,3}){3}$/.test(hostname)) return true;
  return false;
}

/** True when environment may default to `test` (loopback, .localhost, .test hosts). */
export function isImplicitTestHost(hostname: string): boolean {
  return isLoopbackHost(hostname) || hostname.endsWith('.test');
}

const FORBIDDEN_PROTOCOLS = new Set(['file:', 'data:', 'javascript:']);

/**
 * Resolves a navigation URL against the base and enforces the allowed-origin
 * policy. Returns the absolute URL string.
 */
export function resolveNavigationUrl(
  input: string,
  base: NormalizedBaseUrl | undefined,
  allowedOrigins: readonly string[],
): { url: string } {
  let url: URL;
  try {
    url = new URL(input, base?.href);
  } catch {
    // A relative reference has nothing to resolve against on a target whose
    // engine declares no URL; that is a missing URL, not a malformed one.
    if (base === undefined && !URL.canParse(input)) {
      throw new ConfigurationError(
        'APP_URL_REQUIRED',
        `navigation to "${input}" needs an app URL; the target's engine declares none`,
      );
    }
    throw new ConfigurationError('POLICY_DENIED', `malformed URL: ${input}`);
  }
  if (FORBIDDEN_PROTOCOLS.has(url.protocol)) {
    throw new ConfigurationError('POLICY_DENIED', `forbidden URL scheme: ${url.protocol}`);
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new ConfigurationError(
      'POLICY_DENIED',
      `origin ${url.origin} is not in allowedOrigins`,
    );
  }
  return { url: url.href };
}

/**
 * Compares a current URL to an expected string/regexp per 03-assertions.md.
 * Relative expected strings resolve against the base URL; string comparison is
 * exact after WHATWG serialization; regexps test the complete serialized URL.
 */
export function urlMatches(current: string, expected: string | RegExp, baseHref: string): boolean {
  if (typeof expected === 'string') {
    let expectedUrl: URL;
    try {
      expectedUrl = new URL(expected, baseHref);
    } catch {
      return false;
    }
    return serializeForComparison(current) === expectedUrl.href;
  }
  return testPattern(expected.source, expected.flags, serializeForComparison(current));
}

function serializeForComparison(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
