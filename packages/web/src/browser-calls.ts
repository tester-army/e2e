/**
 * The driver-neutral halves of the `browser` fixture's calls: the route
 * handler contract, response bodies, cookie targets, and argument checks.
 * Each driver's fixture supplies only what its protocol does.
 */

import {
  ConfigurationError,
  obj,
  raceAbort,
  rejectUnknownOptions,
  stepTimeout,
  TestError,
  withTimeout,
  type EngineFixtureContext,
} from 'e2e/engine';
import type { Browser, CookieFilter, WebResponse, WebRoute } from './browser.ts';
import { MEDIA_KEYS, mediaProblem, type WebMedia } from './media.ts';
import { parseContinue, parseFulfill, requireNoArguments, type ContinueDecision, type FulfillDecision } from './route-options.ts';
import { message } from './support.ts';

/** What one driver does with a held request; `runRouteHandler` decides which, once. */
export interface RouteAdapter {
  readonly request: WebRoute['request'];
  fetch(): Promise<WebResponse>;
  fulfill(decision: FulfillDecision): Promise<void>;
  continue(decision: ContinueDecision): Promise<void>;
  fallback(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Runs one test route handler on a held request with Playwright's route contract:
 * exactly one of fulfill, continue, fallback, or abort. Options are checked
 * before the decision, so a rejected one leaves the request to the abort. A
 * handler that decides twice, returns undecided, or throws fails the next
 * step with its cause (`latch`), and an undecided or failed decision aborts
 * the request rather than leaving it pending.
 */
export async function runRouteHandler(
  handler: Parameters<Browser['route']>[1],
  adapter: RouteAdapter,
  latch: (error: Error) => void,
  context: EngineFixtureContext,
  resolvePath: (file: string) => string,
): Promise<void> {
  let decided = false;
  const abortQuietly = async (): Promise<void> => {
    try {
      await adapter.abort();
    } catch {
      return;
    }
  };
  const decideWith = async (name: string, act: () => Promise<void>): Promise<void> => {
    if (decided) throw new TestError('ACTION_FAILED', `route handler already decided; ${name} called twice`);
    decided = true;
    try {
      await act();
    } catch (cause) {
      await abortQuietly();
      throw cause;
    }
  };
  const route: WebRoute = {
    request: adapter.request,
    fetch: async (...args: unknown[]) => {
      requireNoArguments('route.fetch', args);
      return adapter.fetch();
    },
    fulfill: async (response) => {
      const decision = parseFulfill(response, resolvePath);
      await decideWith('fulfill', () => adapter.fulfill(decision));
    },
    continue: async (overrides) => {
      const decision = parseContinue(overrides, adapter.request.url, context.app.resolveUrl);
      await decideWith('continue', () => adapter.continue(decision));
    },
    fallback: async (...args: unknown[]) => {
      requireNoArguments('route.fallback', args);
      await decideWith('fallback', () => adapter.fallback());
    },
    abort: async (...args: unknown[]) => {
      requireNoArguments('route.abort', args);
      await decideWith('abort', () => adapter.abort());
    },
  };
  try {
    await handler(route);
    if (!decided) throw new TestError('ACTION_FAILED', 'route handler returned without calling fulfill, continue, fallback, or abort');
  } catch (cause) {
    latch(cause instanceof Error ? cause : new TestError('ACTION_FAILED', `route handler failed: ${message(cause)}`));
    if (!decided) await abortQuietly();
  }
}

/**
 * Reads the body once the response is known and keeps the outcome: a body
 * that arrived returns a copy of its bytes on every call, a body the browser could not
 * read rejects every call with `ACTION_FAILED` naming the cause. Swallowing
 * that failure would hand the test an empty string the server never sent,
 * indistinguishable from a real empty body. `failure` names the reason the
 * browser reported on a page request (`net::ERR_CONTENT_LENGTH_MISMATCH` for
 * a connection cut short of the declared length, `net::ERR_ABORTED` for a
 * request the page aborted), and the error behind the read is the fallback,
 * as for a redirect, whose body the browser never keeps.
 */
export async function readResponseBody(
  api: 'waitForResponse' | 'route.fetch',
  body: () => Promise<Buffer>,
  failure: () => string | undefined = () => undefined,
): Promise<() => Promise<Buffer>> {
  try {
    const bytes = await body();
    return () => Promise.resolve(Buffer.from(bytes));
  } catch (cause) {
    const error = new TestError('ACTION_FAILED', `${api}: response body could not be read: ${failure() ?? message(cause)}`);
    return () => Promise.reject(error);
  }
}

/** The `WebResponse` over a response's metadata and a reader for its body bytes. */
export function webResponse(fields: Pick<WebResponse, 'url' | 'status' | 'headers'>, body: () => Promise<Buffer>): WebResponse {
  const text = async (): Promise<string> => new TextDecoder().decode(await body());
  return {
    ...fields,
    body,
    // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
    json: async <T = unknown>() => JSON.parse(await text()) as T,
    text,
  };
}

/**
 * A matched response as `waitForResponse` reports it. The body read started
 * when the response was known, and is awaited only by the body readers on a
 * budget of their own: the wait's timeout bounds the match, never a body
 * still streaming in behind headers that already arrived.
 */
export function waitedResponse(
  context: EngineFixtureContext,
  fields: Pick<WebResponse, 'url' | 'status' | 'headers'>,
  body: Promise<() => Promise<Buffer>>,
): WebResponse {
  return webResponse(fields, async () => {
    const { signal, timeoutMs } = context.operation();
    const read = await raceAbort(
      withTimeout(body, timeoutMs, () => new TestError('ACTION_FAILED', `waitForResponse: response body did not finish within ${timeoutMs}ms`)),
      signal,
      'waitForResponse body',
    );
    return read();
  });
}

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

/** A download wait's budget: its checked `timeout` (0 for none), else undefined for the action timeout. */
export function downloadTimeout(timeout: number | undefined, api: string): number | undefined {
  return stepTimeout(timeout, api);
}
