/**
 * `browser.clearCookies` against a real browser context: filters combine, a
 * string matches a field exactly and a RegExp matches its text, no options
 * clears every cookie, HttpOnly ones included, and page storage stays.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, CookieFilter } from '../../src/browser.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('browser.clearCookies', () => {
  let session: WebSession;
  let origin: string;
  let browser: Browser;
  const page = { evaluate: <T,>(fn: () => T) => browser.evaluate(fn as never) as Promise<T> };

  beforeAll(async () => {
    session = await startWebSession({ startAttempt: false });
    origin = session.origin;
    session.serve('/', '<!doctype html><title>Cookies</title>');
  });

  beforeEach(async () => {
    await session.startAttempt();
    await session.open(`${origin}/`);
    browser = session.browser;
    await browser.setCookies([
      { name: 'session', value: 'root', domain: '127.0.0.1', path: '/', httpOnly: true },
      { name: 'session', value: 'admin', domain: '127.0.0.1', path: '/admin', httpOnly: true },
      { name: 'session-id', value: 'x', domain: '127.0.0.1', path: '/' },
      { name: 'language', value: 'en', domain: '127.0.0.1', path: '/' },
    ]);
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  /** The remaining cookies as sorted `name=value` pairs. */
  const remaining = async (): Promise<string[]> =>
    (await browser.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).toSorted();

  it.each<[string, CookieFilter, string[]]>([
    ['combines filters', { name: 'session', path: '/admin' }, ['language=en', 'session-id=x', 'session=root']],
    ['matches a string exactly', { name: 'session' }, ['language=en', 'session-id=x']],
    ['matches a RegExp', { name: /^session/ }, ['language=en']],
    ['clears HttpOnly cookies by domain', { domain: '127.0.0.1', path: /^\/admin$/ }, ['language=en', 'session-id=x', 'session=root']],
  ])('%s', async (_name, filter, expected) => {
    await browser.clearCookies(filter);
    expect(await remaining()).toEqual(expected);
  });

  it('clears every cookie without options and keeps page storage', async () => {
    await page.evaluate(() => {
      localStorage.setItem('preference', 'kept');
      sessionStorage.setItem('tab', 'kept');
      return null;
    });
    await browser.clearCookies();
    expect(await remaining()).toEqual([]);
    expect(await page.evaluate(() => [localStorage.getItem('preference'), sessionStorage.getItem('tab')])).toEqual(['kept', 'kept']);
  });

  it('refuses an unknown filter and a value that is not a string or RegExp, clearing nothing', async () => {
    const refused = expect.objectContaining({ code: 'INVALID_ARGUMENT' });
    // The harness records each fixture call as a step, so a refusal thrown before the call's promise is a rejection all the same.
    const clear = (filter: unknown) => Promise.resolve().then(() => browser.clearCookies(filter as CookieFilter));
    await expect(clear({ url: origin })).rejects.toThrow(refused);
    await expect(clear({ name: 1 })).rejects.toThrow(refused);
    expect(await remaining()).toHaveLength(4);
  });
});
