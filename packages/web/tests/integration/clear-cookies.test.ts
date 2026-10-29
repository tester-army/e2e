/**
 * `browser.clearCookies` against a real browser context: filters combine, a
 * string matches a field exactly and a RegExp matches its text, no options
 * clears every cookie, HttpOnly ones included, and page storage stays.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import type { EngineFixtureContext } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser, type CookieFilter } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Answers every path with an empty page. */
function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Cookies</title>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('browser.clearCookies', () => {
  const surface = new PlaywrightSurface({});
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-clear-cookies-'));
  const signal = new AbortController().signal;
  let server: Server;
  let origin: string;
  let page: Page;
  let browser: Browser;

  beforeAll(async () => {
    const started = await startServer();
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
    await surface.init({ runId: 'cookies', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'cookies', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    browser = createBrowserFixture(surface, {
      app: { site: '127.0.0.1', resolveUrl: (url: string) => new URL(url, `${origin}/`).href },
      operation: (timeoutMs = 5_000) => ({ signal, timeoutMs, runId: 'cookies', attemptId: 'cookies', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
    await browser.setCookies([
      { name: 'session', value: 'root', domain: '127.0.0.1', path: '/', httpOnly: true },
      { name: 'session', value: 'admin', domain: '127.0.0.1', path: '/admin', httpOnly: true },
      { name: 'session-id', value: 'x', domain: '127.0.0.1', path: '/' },
      { name: 'language', value: 'en', domain: '127.0.0.1', path: '/' },
    ]);
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
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
    });
    await browser.clearCookies();
    expect(await remaining()).toEqual([]);
    expect(await page.evaluate(() => [localStorage.getItem('preference'), sessionStorage.getItem('tab')])).toEqual(['kept', 'kept']);
  });

  it('refuses an unknown filter and a value that is not a string or RegExp, clearing nothing', async () => {
    const refused = expect.objectContaining({ code: 'INVALID_ARGUMENT' });
    expect(() => browser.clearCookies({ url: origin } as unknown as CookieFilter)).toThrow(refused);
    expect(() => browser.clearCookies({ name: 1 } as unknown as CookieFilter)).toThrow(refused);
    expect(await remaining()).toHaveLength(4);
  });
});
