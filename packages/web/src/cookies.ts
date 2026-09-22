/**
 * Cookies on the browser side of the engine: the shape `web.setCookies`
 * takes, and the `web({ cookies })` option that seeds the same shape
 * into every context the engine creates. The option is checked at config
 * load; the surface seeds it on each fresh context, under whatever a
 * restored session brought.
 */

import type { BrowserContext } from 'playwright';
import { ConfigurationError } from 'e2e/engine';
import { isRecord } from './support.ts';

export interface CookieFields {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  /** HttpOnly flag. */
  httpOnly?: boolean;
  /** Secure flag. */
  secure?: boolean;
  /** SameSite attribute. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** `url`, or `domain` with an optional `path`, never both. */
export type Cookie = CookieFields &
  (
    | { url: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

/**
 * A cookie of `web({ cookies })`: what `web.setCookies` takes, except
 * that `url` may be omitted, which targets the app's own `url`.
 */
export type WebCookie = CookieFields &
  (
    | { url?: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

/** One cookie as `BrowserContext.addCookies` takes it. */
export type ContextCookie = Parameters<BrowserContext['addCookies']>[0][number];

/** The cookies as `addCookies` takes them: `url`, or `domain` with `path` defaulting to `/`. */
export function toContextCookies(cookies: readonly Cookie[]): ContextCookie[] {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    ...(cookie.url === undefined ? { domain: cookie.domain, path: cookie.path ?? '/' } : { url: cookie.url }),
    ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
    ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
    ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
    ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
  }));
}

const SAME_SITE_VALUES = new Set(['Strict', 'Lax', 'None']);

/** A control character, or the separator that would end the cookie early in a `Cookie` header. */
// oxlint-disable-next-line no-control-regex -- the control characters are the point
const COOKIE_TOKEN_BREAK = /[\u0000-\u001F\u007F;]/;
/** A cookie domain as the browser stores it: host labels, an optional leading dot, no scheme, port, or path. */
const COOKIE_DOMAIN = /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\.?localhost$|^\.?\d{1,3}(?:\.\d{1,3}){3}$/i;

function invalidCookies(detail: string): ConfigurationError {
  return new ConfigurationError('INVALID_CONFIG', `web({ cookies }) ${detail}`);
}

/**
 * Checks `web({ cookies })` at config load, so a cookie the browser
 * would refuse fails the run before it launches, and fills the app's `url`
 * into a cookie that names neither `url` nor `domain`. Config runs as
 * JavaScript, so the types alone are no guard. The app URL is normalized the
 * way the harness normalizes it: a missing scheme becomes `https://`, or
 * `http://` for a loopback host.
 */
export function configuredCookies(cookies: unknown, appUrl: string | undefined): readonly Cookie[] {
  if (!Array.isArray(cookies)) throw invalidCookies('must be an array of cookies');
  return cookies.map((cookie: unknown, index): Cookie => {
    if (!isRecord(cookie)) throw invalidCookies(`entry ${String(index)} must be an object with name and value`);
    const { name, value, url, domain, path, expires, httpOnly, secure, sameSite } = cookie;
    if (typeof name !== 'string' || name === '' || COOKIE_TOKEN_BREAK.test(name) || /[=\s]/.test(name)) {
      throw invalidCookies(`entry ${String(index)} requires a non-empty cookie name without "=", ";", whitespace, or a control character`);
    }
    const label = `cookie "${name}"`;
    if (typeof value !== 'string' || COOKIE_TOKEN_BREAK.test(value)) {
      throw invalidCookies(`${label} requires a value string without ";" or a control character`);
    }
    if (url !== undefined && domain !== undefined) throw invalidCookies(`${label} takes url or domain, not both`);
    if (expires !== undefined && !Number.isFinite(expires)) throw invalidCookies(`${label} expires must be a finite number of seconds`);
    if (httpOnly !== undefined && typeof httpOnly !== 'boolean') throw invalidCookies(`${label} httpOnly must be a boolean`);
    if (secure !== undefined && typeof secure !== 'boolean') throw invalidCookies(`${label} secure must be a boolean`);
    if (sameSite !== undefined && (typeof sameSite !== 'string' || !SAME_SITE_VALUES.has(sameSite))) {
      throw invalidCookies(`${label} sameSite must be "Strict", "Lax", or "None"`);
    }
    const fields = {
      name,
      value,
      ...(expires === undefined ? {} : { expires: expires as number }),
      ...(httpOnly === undefined ? {} : { httpOnly: httpOnly as boolean }),
      ...(secure === undefined ? {} : { secure: secure as boolean }),
      ...(sameSite === undefined ? {} : { sameSite: sameSite as 'Strict' | 'Lax' | 'None' }),
    };
    if (domain !== undefined) {
      if (typeof domain !== 'string' || !COOKIE_DOMAIN.test(domain)) {
        throw invalidCookies(`${label} domain must be a host name, optionally with a leading dot, such as "example.test" or ".example.test"`);
      }
      if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/') || COOKIE_TOKEN_BREAK.test(path))) {
        throw invalidCookies(`${label} path must start with "/" and contain no ";" or control character`);
      }
      return { ...fields, domain, ...(path === undefined ? {} : { path }) };
    }
    if (path !== undefined) throw invalidCookies(`${label} path applies to a domain cookie; a url cookie carries its path`);
    if (url !== undefined) {
      if (typeof url !== 'string' || !isHttpUrl(url)) throw invalidCookies(`${label} url must be an absolute http(s) URL`);
      return { ...fields, url };
    }
    if (appUrl === undefined) throw invalidCookies(`${label} names no url or domain, and the target has no url to default to`);
    const target = appCookieUrl(appUrl);
    if (target === undefined) throw invalidCookies(`${label} defaults to the target url, which is not a URL: ${appUrl}`);
    return { ...fields, url: target };
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The app's `url` as a cookie target. Mirrors the harness's scheme rule for a
 * schemeless declaration: `localhost:3000` parses as scheme `localhost:`
 * under WHATWG rules, so a `scheme:` prefix counts as explicit only when what
 * follows the colon is not a port. A port of 0, which the run replaces,
 * changes nothing: a cookie is scoped by host, never by port.
 */
function appCookieUrl(appUrl: string): string | undefined {
  const explicit = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(appUrl);
  const candidate = explicit ? appUrl : `https://${appUrl}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!explicit && isLoopbackHost(url.hostname)) url.protocol = 'http:';
  return isHttpUrl(url.href) ? url.href : undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * Seeds the configured cookies into a fresh context, under whatever the
 * context was created with. A restored session's cookies are read first and
 * written back last, so a name both carry keeps the session's value; a
 * context with none of its own (a sessionless test, a `clearState`) gets the
 * configured ones alone.
 */
export async function seedCookies(
  context: BrowserContext,
  cookies: readonly ContextCookie[] | undefined,
): Promise<void> {
  if (cookies === undefined || cookies.length === 0) return;
  const restored = await context.cookies();
  await context.addCookies(cookies);
  if (restored.length > 0) await context.addCookies(restored);
}
