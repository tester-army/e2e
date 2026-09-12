/** URL normalization and origin policy helpers. */

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
  if (url.port === '0' && !isLoopbackAddress(url.hostname)) {
    throw new ConfigurationError(
      'INVALID_APP_URL',
      `port 0 asks the run for a free port and takes only the loopback address the command will bind, 127.0.0.1 or [::1]; a name like localhost may resolve to another one: ${raw}`,
    );
  }
  return { href: url.href, origin: url.origin, basePath: url.pathname };
}

/**
 * True for a literal loopback address, `127.x.x.x` or `[::1]`. A free port is
 * free on one address family only, so a port-0 URL must name the address the
 * command binds rather than a name that may resolve to either.
 */
function isLoopbackAddress(hostname: string): boolean {
  return hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** True when the URL was declared with port 0: the run picks a free port on its address and substitutes it. */
export function requestsFreePort(base: NormalizedBaseUrl): boolean {
  return new URL(base.href).port === '0';
}

/** The port the base URL is served on: the explicit one, else the scheme's default. */
export function portOf(base: NormalizedBaseUrl): number {
  const url = new URL(base.href);
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** The base URL re-serialized on another port; everything else is kept. */
export function withPort(base: NormalizedBaseUrl, port: number): NormalizedBaseUrl {
  const url = new URL(base.href);
  url.port = String(port);
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
 * Resolves a navigation URL against the base and refuses the schemes no test
 * may open. Returns the absolute URL string. Any http(s) origin is admitted:
 * a click can reach one just as well, so a gate on typed navigation alone
 * would guard nothing.
 */
export function resolveNavigationUrl(input: string, base: NormalizedBaseUrl | undefined): { url: string } {
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
  return { url: url.href };
}

/**
 * The site a hostname belongs to: its registrable domain, approximated
 * without a public suffix list as the last two labels, or the last three
 * when the last is a two-letter country code and the one before it a short
 * second-level label (`example.co.uk`, `shop.com.au`). An IP literal or a
 * single-label host such as `localhost` is a site of its own. Where the
 * approximation errs it errs narrow, except on shared hosting suffixes such
 * as `vercel.app`, which it reads as one site.
 */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const keep = tld.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * True when a URL's host is on `site` as `siteOf` reads it. This is the one
 * rule for where the app's secrets, headers, and basic-auth credentials may
 * go and which child frames an observation reads; an unparseable URL is off
 * every site.
 */
export function sameSite(url: string | URL, site: string): boolean {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return siteOf(parsed.hostname) === site;
  } catch {
    return false;
  }
}

/**
 * Compares a current URL to an expected string/regexp.
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
