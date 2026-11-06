import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/fixture/types.ts';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

/**
 * One origin with a body for every outcome `waitForResponse` reports: a full
 * JSON body, a genuinely empty body under 200 and 204, a redirect whose body
 * the browser drops, and a body cut short by a connection reset before the
 * declared `Content-Length` was sent, one whose body follows its headers
 * 800ms later, and one that never finishes. The fragment is flushed before the
 * reset so the browser has seen the headers and reports the response rather
 * than an empty reply.
 */
function startBodyServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    switch (request.url) {
      case '/':
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Bodies</title><h1>Bodies</h1>');
        return;
      case '/api/full':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      case '/api/empty':
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '0' });
        response.end();
        return;
      case '/api/no-content':
        response.writeHead(204);
        response.end();
        return;
      case '/api/redirect':
        response.writeHead(302, { location: '/api/full', 'content-type': 'text/plain' });
        response.end('moved');
        return;
      case '/api/slow':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.flushHeaders();
        setTimeout(() => response.end('slow-body'), 800);
        return;
      case '/api/endless':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('a first chunk and never the rest');
        return;
      case '/api/cut':
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        response.write('{"partial":', () => {
          setTimeout(() => response.socket?.destroy(), 50);
        });
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('browser.waitForResponse bodies', () => {
  let session: WebSession;
  let server: Server;
  let origin: string;
  let browser: Browser;

  beforeAll(async () => {
    ({ server, url: origin } = await startBodyServer());
    session = await startWebSession({ appUrl: origin, timeoutMs: 2_000, startAttempt: false });
  });

  beforeEach(async () => {
    await session.startAttempt();
    browser = session.browser;
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Fires one page-side fetch that reads its body the way an app does and
   * returns the response `waitForResponse` observed for it.
   */
  async function observe(pathname: string, options?: { timeout: number }) {
    await session.open(`${origin}/`);
    const [response] = await Promise.all([
      browser.waitForResponse(`**${pathname}`, options),
      browser.evaluate(
        (url: string) => { void fetch(url).then((reply) => reply.text()).catch(() => undefined); return null; },
        `${origin}${pathname}`,
      ),
    ]);
    return response;
  }

  it('observes the first navigation before any page is open', async () => {
    const [response] = await Promise.all([
      browser.waitForResponse(`${origin}/`),
      browser.goto('/'),
    ]);
    expect(response.url).toBe(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html');
    await expect(response.text()).resolves.toContain('<h1>Bodies</h1>');
  });

  it('reads a full body as text and JSON', async () => {
    const response = await observe('/api/full');
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each([
    ['/api/empty', 200],
    ['/api/no-content', 204],
  ])('resolves a genuinely empty body at %s to an empty string', async (pathname, status) => {
    const response = await observe(pathname);
    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe('');
  });

  it('keeps the status of a body the connection cut short and rejects reading it', async () => {
    const response = await observe('/api/cut');
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${origin}/api/cut`);
    expect(response.headers['content-length']).toBe('1000');
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('waitForResponse: response body could not be read'),
    });
    await expect(response.json()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
  });

  it('matches on headers inside its timeout and lets text() wait for a slower body', async ({ skip }) => {
    skip(onFirefox, 'Firefox limit: Firefox sends network.responseStarted only once the body starts, not when the headers arrive');
    const response = await observe('/api/slow', { timeout: 500 });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('slow-body');
  });

  it('rejects reading a body that never finishes once the action budget runs out', async () => {
    const response = await observe('/api/endless', { timeout: 500 });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'waitForResponse: response body did not finish within 2000ms',
    });
  });

  it('keeps the status of a redirect and rejects reading its body', async () => {
    const response = await observe('/api/redirect');
    expect(response.status).toBe(302);
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('Response body is unavailable for redirect responses'),
    });
  });
});
