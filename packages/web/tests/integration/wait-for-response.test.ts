import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { withTimeout, type EngineFixtureContext } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

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
  const surface = new PlaywrightSurface({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-wait-for-response-'));
  const signal = new AbortController().signal;
  let server: Server;
  let origin: string;
  let page: Page;
  let browser: Browser;
  let operationBudgetMs: number;

  beforeAll(async () => {
    ({ server, url: origin } = await startBodyServer());
    await surface.init({ runId: 'responses', targetName: 'web', projectRoot: process.cwd(),
      app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'responses', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    operationBudgetMs = 2_000;
    browser = createBrowserFixture(surface, {
      app: { resolveUrl: (url: string) => new URL(url, `${origin}/`).href },
      timeouts: { test: 5_000 },
      operation: (timeoutMs = operationBudgetMs) => ({ signal, timeoutMs, runId: 'responses', attemptId: 'responses', origin: 'test' }),
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
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /**
   * Fires one page-side fetch that reads its body the way an app does and
   * returns the response `waitForResponse` observed for it.
   */
  async function observe(pathname: string, options?: { timeout: number }) {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    // The harness's step bound, as the fixture recorder applies it to every `browser` call.
    const bound = options?.timeout ?? 2_000;
    const [response] = await Promise.all([
      withTimeout(browser.waitForResponse(`**${pathname}`, options), bound, () => new Error(`step exceeded ${bound}ms`)),
      page.evaluate(
        (url) => { void fetch(url).then((reply) => reply.text()).catch(() => undefined); },
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
    expect(surface.requireContext().pages()).toEqual([surface.requirePage()]);
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
      message: 'waitForResponse: response body could not be read: net::ERR_CONTENT_LENGTH_MISMATCH',
    });
    await expect(response.json()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
  });

  it('matches on headers inside its timeout and lets text() wait for a slower body', async () => {
    const response = await observe('/api/slow', { timeout: 500 });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('slow-body');
  });

  it('rejects reading a body that never finishes once the action budget runs out', async () => {
    const response = await observe('/api/endless', { timeout: 500 });
    expect(response.status).toBe(200);
    operationBudgetMs = 300;
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'waitForResponse: response body did not finish within 300ms',
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
