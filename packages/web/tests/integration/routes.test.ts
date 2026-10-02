/**
 * Route decisions against a server that counts what reaches it: `continue`
 * goes to the network past every other route and carries the configured
 * site headers itself, `fallback` hands the request to the route before it,
 * the overrides each decision implements reach the wire, and an option it
 * does not implement fails the next step instead of being dropped. Also the
 * one call beside routing that takes a URL the same way: a relative cookie
 * URL.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { TestError, type EngineFixtureContext } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser, type WebRoute } from '../../src/browser.ts';
import { noSecrets } from '../helpers/secrets.ts';

interface Echo {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * `/echo` answers with what it received; `/api/*` answers `network:<path>`.
 * Every request is counted by path.
 */
function startCountingServer(hits: Map<string, number>): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://host').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    if (pathname === '/echo') {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ path: pathname, method: request.method, headers: request.headers, body }));
      });
      return;
    }
    if (pathname.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`network:${pathname}`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Routes</title><h1>Routes</h1>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('browser.route decisions', () => {
  const surface = new PlaywrightSurface({ headers: { 'X-Gate': 'open-sesame' } });
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-routes-'));
  const signal = new AbortController().signal;
  const hits = new Map<string, number>();
  let server: Server;
  let origin: string;
  let otherSite: string;
  let page: Page;
  let browser: Browser;

  /** The harness's navigation rule as far as these tests reach it: relative to the base, `file:` denied. */
  const resolveUrl = (url: string): string => {
    const resolved = new URL(url, `${origin}/`);
    if (resolved.protocol === 'file:') throw new TestError('POLICY_DENIED', `forbidden URL scheme: ${resolved.protocol}`);
    return resolved.href;
  };

  beforeAll(async () => {
    const started = await startCountingServer(hits);
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
    // The same server under another host name: `localhost` is a site of its own.
    otherSite = `http://localhost:${started.port}`;
    writeFileSync(path.join(projectRoot, 'quote.json'), '{"cents":4200}\n');
    await surface.init({ runId: 'routes', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    hits.clear();
    await surface.startAttempt({ attemptId: 'routes', artifactsDir: projectRoot, signal, resolveSecret: noSecrets });
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    browser = createBrowserFixture(surface, {
      app: { site: '127.0.0.1', resolveUrl },
      operation: (timeoutMs = 5_000) => ({ signal, timeoutMs, runId: 'routes', attemptId: 'routes', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Fetches `url` from the page; a failed fetch reads as `failed`. */
  const fetchText = (url: string): Promise<string> =>
    page.evaluate((target) => fetch(target).then((reply) => reply.text(), () => 'failed'), url);

  /** Fetches `url` from the page and returns its response headers and body. */
  const fetchReply = (url: string): Promise<{ contentType: string | null; body: string }> =>
    page.evaluate(async (target) => {
      const reply = await fetch(target);
      return { contentType: reply.headers.get('content-type'), body: await reply.text() };
    }, url);

  /** Fetches `url` from the page and parses what `/echo` received. */
  const fetchEcho = async (url: string, init?: { method: string; body: string }): Promise<Echo> =>
    JSON.parse(
      await page.evaluate(([target, options]) => fetch(target!, options).then((reply) => reply.text()), [url, init] as const),
    ) as Echo;

  /** Calls a decision the way a JavaScript caller can: any argument, typed or not. */
  const untyped = (decide: (...args: never[]) => Promise<void>, ...args: unknown[]): Promise<void> =>
    (decide as (...rest: unknown[]) => Promise<void>)(...args);

  /** Waits for the latched route failure the next step reports. */
  const nextStepFailure = (): Promise<unknown> => browser.url().then(() => undefined, (error: unknown) => error);

  it('answers with the route registered last when two fulfill', async () => {
    await browser.route('**/api/**', (route) => route.fulfill({ body: 'earlier' }));
    await browser.route('**/api/quote', (route) => route.fulfill({ body: 'later' }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('later');
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it('continue goes to the network past an earlier route', async () => {
    let earlier = 0;
    await browser.route('**/api/**', (route) => {
      earlier += 1;
      return route.fulfill({ body: 'earlier' });
    });
    await browser.route('**/api/quote', (route) => route.continue());
    expect(await fetchText(`${origin}/api/quote`)).toBe('network:/api/quote');
    expect(earlier).toBe(0);
    expect(hits.get('/api/quote')).toBe(1);
  });

  it('fallback hands the request to the route before it', async () => {
    await browser.route('**/api/**', (route) => route.fulfill({ body: 'earlier' }));
    await browser.route('**/api/quote', (route) => route.fallback());
    expect(await fetchText(`${origin}/api/quote`)).toBe('earlier');
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it.each([
    ['continue', (route: WebRoute) => route.continue()],
    ['fallback', (route: WebRoute) => route.fallback()],
  ])('keeps the configured site header through %s', async (_name, decide) => {
    await browser.route('**/echo', decide);
    const echo = await fetchEcho(`${origin}/echo`);
    expect(echo.headers['x-gate']).toBe('open-sesame');
  });

  it('continue replaces the request headers and adds the site header on top', async () => {
    await browser.route('**/echo', (route) =>
      route.continue({ headers: { ...route.request.headers, 'X-Added': 'yes', 'X-GATE': 'forged' } }));
    const echo = await fetchEcho(`${origin}/echo`);
    expect(echo.headers['x-added']).toBe('yes');
    expect(echo.headers['x-gate']).toBe('open-sesame');
  });

  it('continue sends a rewritten url, method, and body without touching the original', async () => {
    await browser.route('**/api/quote', (route) =>
      route.continue({ url: '/echo', method: 'PUT', postData: 'payload' }));
    const echo = await fetchEcho(`${origin}/api/quote`, { method: 'POST', body: 'original' });
    expect([echo.path, echo.method, echo.body]).toEqual(['/echo', 'PUT', 'payload']);
    expect(echo.headers['x-gate']).toBe('open-sesame');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(hits.get('/echo')).toBe(1);
  });

  it('continue to another site leaves the site header behind', async () => {
    await browser.route('**/api/quote', (route) => route.continue({ url: `${otherSite}/echo` }));
    const echo = await fetchEcho(`${origin}/api/quote`);
    expect(echo.headers.host).toBe(`localhost:${new URL(origin).port}`);
    expect(echo.headers['x-gate']).toBeUndefined();
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it.each([
    ['a forbidden scheme', 'file:///etc/hosts', 'POLICY_DENIED', 'forbidden URL scheme: file:'],
    ['another scheme', 'https://127.0.0.1/echo', 'INVALID_ARGUMENT', "route.continue url must keep the request's http: scheme; got https:"],
  ])('continue to %s aborts the request and fails the next step', async (_name, url, code, message) => {
    await browser.route('**/api/quote', (route) => route.continue({ url }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(await nextStepFailure()).toMatchObject({ code, message });
  });

  it('fulfills a project file with its bytes and a type from its extension', async () => {
    await browser.route('**/api/quote', (route) => route.fulfill({ path: 'quote.json' }));
    expect(await fetchReply(`${origin}/api/quote`)).toEqual({ contentType: 'application/json', body: '{"cents":4200}\n' });
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it.each([
    ['a body', { body: 'plain', contentType: 'text/x-quote' }, 'plain'],
    ['json', { json: { cents: 1 }, contentType: 'application/vnd.quote+json' }, '{"cents":1}'],
    ['a file', { path: 'quote.json', contentType: 'text/plain' }, '{"cents":4200}\n'],
  ] as const)('fulfills %s under the given contentType', async (_name, response, body) => {
    await browser.route('**/api/quote', (route) => route.fulfill(response));
    const reply = await fetchReply(`${origin}/api/quote`);
    expect(reply).toEqual({ contentType: response.contentType, body });
  });

  it.each([
    ['an unknown fulfill key', (route: WebRoute) => untyped(route.fulfill, { bodyy: 'typo' }),
      'route.fulfill options has no key "bodyy"; it takes status, headers, contentType, json, body, path'],
    ['two fulfill sources', (route: WebRoute) => untyped(route.fulfill, { body: 'a', json: { b: 1 } }),
      'route.fulfill takes one of json, body, or path; got json and body'],
    ['a missing fulfill file', (route: WebRoute) => route.fulfill({ path: 'missing.json' }),
      `route.fulfill path is not a readable file: ${path.join(projectRoot, 'missing.json')}`],
    ['a fulfill path through a file', (route: WebRoute) => route.fulfill({ path: 'quote.json/inner' }),
      `route.fulfill path is not a readable file: ${path.join(projectRoot, 'quote.json', 'inner')}`],
    ['a fulfill status out of range', (route: WebRoute) => route.fulfill({ status: 42 }),
      'route.fulfill status must be an integer from 100 to 599'],
    ['fulfill json that is not JSON', (route: WebRoute) => untyped(route.fulfill, { json: { n: 1n } }),
      expect.stringContaining('route.fulfill json')],
    ['an unknown continue key', (route: WebRoute) => untyped(route.continue, { urll: '/echo' }),
      'route.continue options has no key "urll"; it takes url, method, headers, postData'],
    ['non-string continue headers', (route: WebRoute) => untyped(route.continue, { headers: { 'x-n': 1 } }),
      'route.continue header "x-n" must be a string, got number'],
    ['a continue header name outside the token grammar', (route: WebRoute) => route.continue({ headers: { 'x a': 'b' } }),
      'route.continue has an invalid header name: "x a"'],
    ['a line break in a fulfill header value', (route: WebRoute) => route.fulfill({ headers: { 'x-a': 'b\r\nset-cookie: c=d' } }),
      'route.fulfill header "x-a" must not contain a control character'],
    ['an abort error code', (route: WebRoute) => untyped(route.abort, 'failed'),
      'route.abort() takes no arguments'],
    ['a fallback override', (route: WebRoute) => untyped(route.fallback, { url: '/echo' }),
      'route.fallback() takes no arguments'],
  ])('rejects %s before deciding, and aborts the request', async (_name, decide, message) => {
    await browser.route('**/api/quote', decide);
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(await nextStepFailure()).toMatchObject({ code: 'INVALID_ARGUMENT', message });
  });

  it('takes the decision the moment fulfill is called, awaited or not', async () => {
    await browser.route('**/api/quote', (route) => { void route.fulfill({ path: 'quote.json' }); });
    expect(await fetchText(`${origin}/api/quote`)).toBe('{"cents":4200}\n');
    await expect(browser.url()).resolves.toBe(`${origin}/`);
  });

  it('sets a cookie with a relative url on the base URL', async () => {
    await browser.setCookies([{ name: 'flavor', value: 'oatmeal', url: '/' }]);
    const cookies = await browser.cookies();
    expect(cookies.map(({ name, value, domain, path: cookiePath }) => ({ name, value, domain, path: cookiePath })))
      .toEqual([{ name: 'flavor', value: 'oatmeal', domain: '127.0.0.1', path: '/' }]);
  });
});
