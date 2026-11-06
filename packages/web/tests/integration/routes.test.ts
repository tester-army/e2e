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
import { TestError } from 'e2e/engine';
import type { Browser, WebRoute } from '../../src/browser.ts';
import { browserFixture, startWebSession, type WebSession } from '../helpers/web-session.ts';

interface Echo {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Every byte value once, which no text decoding keeps intact. */
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, index) => index);

/**
 * `/echo` answers with what it received; `/api/*` answers `network:<path>`;
 * `/binary` answers `ALL_BYTES`. Every request is counted by path.
 */
function startCountingServer(hits: Map<string, number>): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://host').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    if (pathname === '/redirect') {
      response.writeHead(302, { location: '/echo' });
      response.end();
      return;
    }
    if (pathname === '/binary') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(ALL_BYTES);
      return;
    }
    if (pathname === '/stream-download') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="stream.bin"',
        'content-length': '4096',
      });
      response.write(Buffer.alloc(1024, 'x'));
      return;
    }
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
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-routes-'));
  const hits = new Map<string, number>();
  let session: WebSession;
  let server: Server;
  let origin: string;
  let otherSite: string;
  let browser: Browser;
  let attached: string[];
  /** The page, through the fixture's `evaluate`. */
  const page = {
    evaluate: <A,>(fn: (arg: A) => unknown, arg: A) => browser.evaluate(fn as never, arg as never) as Promise<never>,
  };

  /** The harness's navigation rule: relative to the base, only http(s) and the exact `about:blank` admitted. */
  const resolveUrl = (url: string): string => {
    const resolved = new URL(url, `${origin}/`);
    if (!['http:', 'https:'].includes(resolved.protocol) && resolved.href !== 'about:blank') {
      throw new TestError('POLICY_DENIED', `forbidden URL scheme: ${resolved.protocol}`);
    }
    return resolved.href;
  };

  beforeAll(async () => {
    const started = await startCountingServer(hits);
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
    // The same server under another host name: `localhost` is a site of its own.
    otherSite = `http://localhost:${started.port}`;
    writeFileSync(path.join(projectRoot, 'quote.json'), '{"cents":4200}\n');
    session = await startWebSession({ web: { headers: { 'X-Gate': 'open-sesame' } }, timeoutMs: 5_000, startAttempt: false, projectRoot });
  });

  beforeEach(async () => {
    hits.clear();
    await session.startAttempt();
    attached = [];
    await session.open(`${origin}/`);
    browser = browserFixture(session.engine, { baseUrl: origin, site: '127.0.0.1', timeoutMs: 5_000, resolveUrl, attach: (relative) => attached.push(relative) });
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
    server.closeAllConnections();
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

  /** Fetches `url` from the page and returns its body bytes. */
  const fetchBytes = async (url: string): Promise<number[]> =>
    page.evaluate((target) => fetch(target).then(async (reply) => [...new Uint8Array(await reply.arrayBuffer())]), url);

  /** Fetches `url` from the page and parses what `/echo` received. */
  const fetchEcho = async (url: string, init?: { method: string; body: string }): Promise<Echo> =>
    JSON.parse(
      await page.evaluate(([target, options]) => fetch(target!, options ?? undefined).then((reply) => reply.text()), [url, init ?? null] as const),
    ) as Echo;

  /** Calls a decision the way a JavaScript caller can: any argument, typed or not. */
  const untyped = (decide: (...args: never[]) => Promise<void>, ...args: unknown[]): Promise<void> =>
    (decide as (...rest: unknown[]) => Promise<void>)(...args);

  /** Waits for the latched route failure the next step reports. */
  const nextStepFailure = (): Promise<unknown> => browser.url().then(() => undefined, (error: unknown) => error);

  it('fetches upstream once, keeps site headers, then fulfills an amended response', async () => {
    await browser.route('**/echo', async route => {
      const upstream = await route.fetch();
      expect(upstream.status).toBe(200);
      expect(upstream.url).toBe(`${origin}/echo`);
      expect(upstream.headers['content-type']).toContain('application/json');
      const echo = await upstream.json<Echo>();
      expect(echo.headers['x-gate']).toBe('open-sesame');
      expect(JSON.parse(await upstream.text())).toEqual(echo);
      await route.fulfill({ json: { ...echo, amended: true } });
    });
    expect(await page.evaluate(async url => (await fetch(url)).json(), `${origin}/echo`)).toMatchObject({ amended: true });
    expect(hits.get('/echo')).toBe(1);
  });

  it('returns an upstream redirect without following it', async () => {
    await browser.route('**/redirect', async route => {
      const upstream = await route.fetch();
      expect(upstream.status).toBe(302);
      expect(upstream.headers['location']).toBe('/echo');
      await route.fulfill({ body: 'inspected redirect' });
    });
    expect(await fetchText(`${origin}/redirect`)).toBe('inspected redirect');
    expect(hits.get('/redirect')).toBe(1);
    expect(hits.get('/echo')).toBeUndefined();
  });

  it('hands timeout 0 to the operation as a budget only the test deadline caps, and refuses a negative one', async () => {
    const asked: (number | undefined)[] = [];
    const recording = browserFixture(session.engine, {
      baseUrl: origin,
      site: '127.0.0.1',
      resolveUrl,
      operation: (timeoutMs?: number) => {
        asked.push(timeoutMs);
        return { signal: new AbortController().signal, timeoutMs: Math.min(timeoutMs ?? 5_000, 5_000), runId: 'routes', attemptId: 'routes', origin: 'test' };
      },
    });
    await recording.goto(`${origin}/`, { timeout: 0 });
    await recording.waitForURL(`${origin}/`, { timeout: 0 });
    expect(asked.slice(0, 2)).toEqual([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
    for (const call of [
      async () => recording.goto(`${origin}/`, { timeout: -1 }),
      async () => recording.waitForURL(`${origin}/`, { timeout: Number.NaN }),
      async () => recording.waitForDownload(async () => undefined, { timeout: Number.POSITIVE_INFINITY }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it('rejects an invalid download count before running the trigger', async () => {
    let calls = 0;
    // The harness records each fixture call as a step, so a refusal thrown before the call's promise is a rejection all the same.
    await expect(Promise.resolve().then(() => browser.waitForDownloads(async () => { calls += 1; }, { count: 0 }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toBe(0);
  });

  it('fails a multi-download wait whose trigger starts too few downloads', async () => {
    await expect(browser.waitForDownloads(async () => undefined, { count: 2, timeout: 30 })).rejects.toMatchObject({
      code: 'ACTION_FAILED', message: expect.stringContaining('2 downloads'),
    });
  });

  it.each(['waitForDownload', 'waitForDownloads'] as const)('%s bounds saving a download whose HTTP body never finishes', async (method) => {
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/stream-download';
      link.textContent = 'Stream';
      document.body.append(link);
      return null;
    }, null);
    const trigger = async () => { await page.evaluate(() => { document.querySelector<HTMLAnchorElement>('a')!.click(); return null; }, null); };
    const work = method === 'waitForDownload'
      ? browser.waitForDownload(trigger, { timeout: 500 })
      : browser.waitForDownloads(trigger, { count: 1, timeout: 500 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work.then(() => 'completed', (cause: unknown) => cause),
        new Promise((resolve) => { timer = setTimeout(() => resolve('still pending'), 1500); }),
      ]);
      expect(result).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('did not finish within') });
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await work.catch(() => undefined);
    }
  });

  it.each(['waitForDownload', 'waitForDownloads'] as const)('%s fails and keeps nothing while its trigger is still pending', async (method) => {
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/stream-download';
      link.textContent = 'Pending';
      document.body.append(link);
      return null;
    }, null);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const trigger = async (): Promise<void> => {
      await page.evaluate(() => { document.querySelector<HTMLAnchorElement>('a')!.click(); return null; }, null);
      await pending;
    };
    const work = method === 'waitForDownload'
      ? browser.waitForDownload(trigger, { timeout: 500 })
      : browser.waitForDownloads(trigger, { count: 1, timeout: 500 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work.then(() => 'completed', (cause: unknown) => cause),
        new Promise((resolve) => { timer = setTimeout(() => resolve('still pending'), 1500); }),
      ]);
      expect(result).toMatchObject({ code: 'ACTION_FAILED' });
      release();
      await work.catch(() => undefined);
      expect(attached).toEqual([]);
    } finally {
      clearTimeout(timer);
      release();
      server.closeAllConnections();
      await work.catch(() => undefined);
    }
  });

  it('keeps a trigger error', async () => {
    const failure = new TestError('ASSERTION_FAILED', 'trigger assertion');
    await expect(browser.waitForDownloads(async () => { throw failure; }, { count: 2, timeout: 30 })).rejects.toBe(failure);
  });

  it('clears every test route, keeps configured site headers, and can register again', async () => {
    await browser.route('**/api/**', route => route.fulfill({ body: 'mock-api' }));
    await browser.route(/\/echo$/, route => route.fulfill({ json: { intercepted: true } }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('mock-api');
    await browser.unrouteAll();
    expect(await fetchText(`${origin}/api/quote`)).toBe('network:/api/quote');
    expect((await fetchEcho(`${origin}/echo`)).headers['x-gate']).toBe('open-sesame');
    await browser.unrouteAll();
    await browser.route('**/api/quote', route => route.fulfill({ body: 'new-mock' }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('new-mock');
    await browser.unroute('**/api/quote');
    expect(await fetchText(`${origin}/api/quote`)).toBe('network:/api/quote');
  });

  it('routes real native dialogs by kind even when their messages are identical', async () => {
    const kinds: string[] = [];
    const off = await browser.onDialog(async dialog => {
      kinds.push(dialog.type);
      if (dialog.type === 'prompt') await dialog.accept('typed answer');
      else if (dialog.type === 'confirm') await dialog.dismiss();
      else await dialog.accept();
    });
    const answers = await browser.evaluate(() => {
      window.alert('same message');
      return { confirmed: window.confirm('same message'), prompt: window.prompt('same message') };
    });
    expect(kinds).toEqual(['alert', 'confirm', 'prompt']);
    expect(answers).toEqual({ confirmed: false, prompt: 'typed answer' });
    await off();
  });

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

  it.each([
    ['the request', '/echo'],
    ['a redirect', '/redirect'],
  ])('continue drops a header set to undefined on %s', async (_name, target) => {
    await browser.route(`**${target}`, (route) =>
      route.continue({ headers: { ...route.request.headers, 'x-drop': undefined, 'x-keep': 'yes' } }));
    const echo = JSON.parse(await page.evaluate(
      (url) => fetch(url, { headers: { 'x-drop': 'a' } }).then((reply) => reply.text()),
      `${origin}${target}`,
    )) as Echo;
    expect(echo.path).toBe('/echo');
    expect(echo.headers['x-drop']).toBeUndefined();
    expect(echo.headers['x-keep']).toBe('yes');
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
    ['a wrapped scheme', 'view-source:file:///etc/hosts', 'POLICY_DENIED', 'forbidden URL scheme: view-source:'],
    ['about:blank', 'about:blank', 'INVALID_ARGUMENT', "route.continue url must keep the request's http: scheme; got about:"],
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
    ['a Buffer', Buffer.from(ALL_BYTES)],
    ['a Uint8Array view', new Uint8Array([0xff, ...ALL_BYTES, 0xff]).subarray(1, 257)],
  ])('fulfills %s body byte for byte', async (_name, body) => {
    await browser.route('**/api/quote', (route) => route.fulfill({ body }));
    expect(await fetchBytes(`${origin}/api/quote`)).toEqual([...ALL_BYTES]);
  });

  it('fetches upstream bytes and fulfills them unchanged', async () => {
    await browser.route('**/binary', async (route) => {
      const upstream = await route.fetch();
      await route.fulfill({ headers: upstream.headers, body: await upstream.body() });
    });
    expect(await fetchBytes(`${origin}/binary`)).toEqual([...ALL_BYTES]);
  });

  it('fulfills a newline-joined set-cookie as one cookie per line', async () => {
    await browser.route('**/api/quote', (route) =>
      route.fulfill({ headers: { 'Set-Cookie': 'a=b\nc=d; Path=/' }, body: '' }));
    await fetchText(`${origin}/api/quote`);
    expect((await browser.cookies()).map(({ name, value }) => `${name}=${value}`).toSorted()).toEqual(['a=b', 'c=d']);
  });

  it('fulfills under the given contentType or a content-type header', async () => {
    await browser.route('**/api/quote', (route) => route.fulfill({ json: { cents: 1 }, contentType: 'application/vnd.quote+json' }));
    expect(await fetchReply(`${origin}/api/quote`)).toEqual({ contentType: 'application/vnd.quote+json', body: '{"cents":1}' });
    await browser.route('**/api/quote', (route) => route.fulfill({ path: 'quote.json', headers: { 'Content-Type': 'text/plain' } }));
    expect(await fetchReply(`${origin}/api/quote`)).toEqual({ contentType: 'text/plain', body: '{"cents":4200}\n' });
  });

  it.each([
    ['an unknown fulfill key', (route: WebRoute) => untyped(route.fulfill, { bodyy: 'typo' }),
      'route.fulfill options has no key "bodyy"; it takes status, headers, contentType, json, body, path'],
    ['two fulfill sources', (route: WebRoute) => untyped(route.fulfill, { body: 'a', json: { b: 1 } }),
      'route.fulfill takes one of json, body, or path; got json and body'],
    ['a missing fulfill file', (route: WebRoute) => route.fulfill({ path: 'missing.json' }),
      `route.fulfill path is not a readable file: ${path.join(projectRoot, 'missing.json')}`],
    ['a fulfill status out of range', (route: WebRoute) => route.fulfill({ status: 42 }),
      'route.fulfill status must be an integer from 100 to 599'],
    ['an unknown continue key', (route: WebRoute) => untyped(route.continue, { urll: '/echo' }),
      'route.continue options has no key "urll"; it takes url, method, headers, postData'],
    ['non-string continue headers', (route: WebRoute) => untyped(route.continue, { headers: { 'x-n': 1 } }),
      'route.continue header "x-n" must be a string, got number'],
    ['a continue header name outside the token grammar', (route: WebRoute) => route.continue({ headers: { 'x a': 'b' } }),
      'route.continue has an invalid header name: "x a"'],
    ['a line break in a fulfill header value', (route: WebRoute) => route.fulfill({ headers: { 'x-a': 'b\r\nset-cookie: c=d' } }),
      'route.fulfill header "x-a" must not contain a control character'],
    ['a carriage return in a set-cookie line', (route: WebRoute) => route.fulfill({ headers: { 'set-cookie': 'a=b\r\nx-a: c' } }),
      'route.fulfill header "set-cookie" must not contain a control character'],
    ['an undefined fulfill header', (route: WebRoute) => untyped(route.fulfill, { headers: { 'x-a': undefined } }),
      'route.fulfill header "x-a" must be a string, got undefined'],
    ['a line break in a continue header value', (route: WebRoute) => route.continue({ headers: { 'set-cookie': 'a=b\nc=d' } }),
      'route.continue header "set-cookie" must not contain a control character'],
    ['a fulfill body that is neither text nor bytes', (route: WebRoute) => untyped(route.fulfill, { body: 42 }),
      'route.fulfill body must be a string, Buffer, or Uint8Array'],
    ['an abort error code', (route: WebRoute) => untyped(route.abort, 'failed'),
      'route.abort() takes no arguments'],
  ])('rejects %s before deciding, and aborts the request', async (_name, decide, message) => {
    await browser.route('**/api/quote', decide);
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(await nextStepFailure()).toMatchObject({ code: 'INVALID_ARGUMENT', message });
  });

  it('aborts the request when the handler returns without deciding, and fails the next step', async () => {
    await browser.route('**/api/quote', () => undefined);
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(await nextStepFailure()).toMatchObject({
      code: 'ACTION_FAILED',
      message: 'route handler returned without calling fulfill, continue, fallback, or abort',
    });
  });

  it('keeps the first decision when the handler decides twice, and fails the next step', async () => {
    await browser.route('**/api/quote', (route) => {
      void route.fulfill({ body: 'first' });
      return route.fulfill({ body: 'second' });
    });
    expect(await fetchText(`${origin}/api/quote`)).toBe('first');
    expect(await nextStepFailure()).toMatchObject({
      code: 'ACTION_FAILED',
      message: 'route handler already decided; fulfill called twice',
    });
  });

  it('fails a navigation its route aborted as an action failure, not an engine fault', async () => {
    await browser.route('**/aborted', (route) => route.abort());
    await expect(browser.goto(`${origin}/aborted`)).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining(`navigation failed: a route aborted the request for ${origin}/aborted`),
    });
  });

  it('fails a navigation with the route error that aborted it', async () => {
    await browser.route('**/refused', (route) => route.fulfill({ headers: { 'bad name': 'x' } }));
    await expect(browser.goto(`${origin}/refused`)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('invalid header name: "bad name"'),
    });
    await expect(browser.url()).resolves.toBe(`${origin}/`);
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
