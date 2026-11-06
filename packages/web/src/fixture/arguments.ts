/**
 * The `browser` fixture's argument checks: cookie targets, cookie filters,
 * emulated media, and download counts.
 */

import { ConfigurationError, obj, rejectUnknownOptions, TestError, type EngineFixtureContext } from 'e2e/engine';
import type { Browser, CookieFilter } from './types.ts';
import { MEDIA_KEYS, mediaProblem, type WebMedia } from '../options.ts';

/** Where one cookie is set: on the URL it names, or on its domain and path. */
export type CookieTarget = { readonly url: string } | { readonly domain: string; readonly path: string };

/**
 * Where each cookie of `browser.setCookies` lands. The harness's URL rule
 * decides which targets are admitted; a domain cookie is checked as the
 * origin it would be sent to, and a relative `url` lands on the base URL the
 * way `goto` would. A target that is not http(s) is `POLICY_DENIED`.
 */
export function cookieTargets(cookies: Parameters<Browser['setCookies']>[0], context: EngineFixtureContext): CookieTarget[] {
  const scheme = new URL(context.app.resolveUrl('')).protocol === 'https:' ? 'https' : 'http';
  return cookies.map((cookie) => {
    const target = context.app.resolveUrl(cookie.url === undefined ? `${scheme}://${cookie.domain.replace(/^\./, '')}` : cookie.url);
    if (!/^https?:/.test(target)) throw new ConfigurationError('POLICY_DENIED', `cookie URL must be http(s): ${target}`);
    return cookie.url === undefined ? { domain: cookie.domain, path: cookie.path ?? '/' } : { url: target };
  });
}

/** Refuses a `browser.clearCookies` filter field that is neither a string nor a RegExp. */
export function requireCookieFilter(options: CookieFilter | undefined): void {
  rejectUnknownOptions('browser.clearCookies', options, ['name', 'domain', 'path']);
  for (const field of ['name', 'domain', 'path'] as const) {
    const value = options?.[field];
    if (value !== undefined && typeof value !== 'string' && !(value instanceof RegExp)) {
      throw new TestError('INVALID_ARGUMENT', `browser.clearCookies ${field} must be a string or RegExp`);
    }
  }
}

/** The media features `browser.emulateMedia` was given, checked and read once, so a later change to the object changes nothing. */
export function requireMedia(media: unknown): WebMedia {
  if (typeof media !== 'object' || media === null) {
    throw new TestError('INVALID_ARGUMENT', 'browser.emulateMedia takes { colorScheme?, reducedMotion? }');
  }
  rejectUnknownOptions('browser.emulateMedia', media, MEDIA_KEYS);
  const requested = media as WebMedia;
  for (const key of MEDIA_KEYS) {
    const problem = mediaProblem((name) => `browser.emulateMedia({ ${name} })`, key, requested[key]);
    if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', problem);
  }
  return obj({ colorScheme: requested.colorScheme, reducedMotion: requested.reducedMotion });
}

/** The count `browser.waitForDownloads` was given, a positive safe integer. */
export function requireDownloadCount(options: Parameters<Browser['waitForDownloads']>[1] | undefined): number {
  rejectUnknownOptions('browser.waitForDownloads', options, ['count', 'timeout']);
  const count = options?.count;
  if (!Number.isSafeInteger(count) || count === undefined || count < 1) {
    throw new TestError('INVALID_ARGUMENT', 'waitForDownloads: count must be a positive safe integer');
  }
  return count;
}
