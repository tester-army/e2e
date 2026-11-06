/**
 * The network where Chromium and Firefox differ, on both: a site icon
 * requested while every request is held (the chromium-bidi mapper drops its
 * events, so on Chromium it goes to the network unrouted rather than hang),
 * a fulfill that forwards an upstream gzip response's headers over the
 * decoded body, and the cookie headers a response wait leaves out.
 */

import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
const TEXT = 'hello gzip world '.repeat(20);

describe.each(['chromium', 'firefox'] as const)('the network on %s', (browser) => {
  let session: WebSession;
  const hits = new Map<string, number>();

  beforeAll(async () => {
    session = await startWebSession({ web: { browser, headers: { 'X-Gate': 'open' } }, timeoutMs: 8_000, startAttempt: false });
    for (const icon of ['/assets/favicon.ico', '/favicon.ico']) {
      session.serve(icon, (_request, response) => {
        hits.set(icon, (hits.get(icon) ?? 0) + 1);
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        response.end(ICON);
      });
    }
    session.serve('/gz', (_request, response) => {
      const zipped = gzipSync(Buffer.from(TEXT));
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(zipped.length) });
      response.end(zipped);
    });
    session.serve('/cookies', (_request, response) => {
      response.setHeader('set-cookie', ['a=1; HttpOnly', 'b=2']);
      response.setHeader('content-type', 'text/plain');
      response.end('ok');
    });
  });

  beforeEach(async () => {
    hits.clear();
    await session.startAttempt();
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  /** Fetches `url` from the page, giving up after 3 s so a request the browser never lets go reads as pending. */
  const fetchText = (url: string): Promise<string> =>
    session.browser.evaluate(
      (target: string) => Promise.race([
        fetch(target).then((reply) => reply.text(), (error: unknown) => `failed: ${String(error)}`),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 3_000)),
      ]),
      url,
    );

  it('loads a page whose image is named favicon.ico while the site headers hold every request', async () => {
    const page = session.serve('/icon-page', '<title>Icon</title><img id="icon" src="/assets/favicon.ico">');
    await session.browser.goto(page);
    const image = await session.browser.evaluate(() => {
      const icon = document.getElementById('icon') as HTMLImageElement;
      return [icon.complete, icon.naturalWidth];
    });
    expect(image).toEqual([true, 4]);
    expect(hits.get('/assets/favicon.ico')).toBe(1);
  });

  it(`sends a page fetch of /favicon.ico to the network past an unrelated route, and ${browser === 'chromium' ? 'past' : 'to'} its own route`, async () => {
    await session.setContent('<title>Icons</title>');
    await session.browser.route('**/nothing', (route) => route.continue());
    await expect(fetchText('/favicon.ico')).resolves.toBe(ICON);
    let routed = false;
    await session.browser.route('**/favicon.ico', async (route) => {
      routed = true;
      await route.fulfill({ body: 'ROUTED' });
    });
    await expect(fetchText('/favicon.ico')).resolves.toBe(browser === 'chromium' ? ICON : 'ROUTED');
    expect(routed).toBe(browser !== 'chromium');
  });

  it('fulfills an amended gzip response with the upstream headers over its decoded body', async () => {
    await session.setContent('<title>Gzip</title>');
    await session.browser.route('**/gz', async (route) => {
      const upstream = await route.fetch();
      expect(upstream.headers['content-encoding']).toBe('gzip');
      await route.fulfill({ status: upstream.status, headers: upstream.headers, body: await upstream.body() });
    });
    await expect(fetchText('/gz')).resolves.toBe(TEXT);
  });

  it('leaves the cookie headers out of a response wait', async () => {
    await session.setContent('<title>Cookies</title>');
    const [response] = await Promise.all([
      session.browser.waitForResponse('**/cookies'),
      session.browser.evaluate(() => fetch('/cookies').then((reply) => reply.text())),
    ]);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['content-type']).toBe('text/plain');
    await expect(response.text()).resolves.toBe('ok');
  });
});
