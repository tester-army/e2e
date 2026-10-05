/**
 * The app log: what a page does on its own during an attempt reaches the
 * harness as one line each, from a real browser: console output, exceptions
 * nothing caught, requests that failed, responses with an error status, and
 * where the page went. A console echo of a failed load, a request the page
 * abandoned, and a navigation the engine made itself are left out, so each
 * event is one line. Each action and `open` hands the harness the screen it
 * left, and the attempt says which browser it ran on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppLogEntry, EngineCleanupContext, EngineFixtureContext, EngineSnapshot, OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const PAGE = `<!doctype html><html><body><h1>Todos</h1><script>
  console.log('ready');
  console.warn('deprecated prop');
  console.error('failed to load todos');
  fetch('/api/todos');
  fetch('/api/missing');
  fetch('/api/reset').catch(() => undefined);
  setTimeout(() => { throw new RangeError('render loop exceeded'); }, 0);
</script></body></html>`;

const MOVING = `<!doctype html><html><body><h1>Moving</h1><button onclick="window.open('/tab', '_blank')">Help</button><script>
  const frame = document.createElement('iframe');
  frame.name = 'pay';
  frame.src = '/embed';
  document.body.append(frame);
  setTimeout(() => { location.href = '/next'; }, 1000);
</script></body></html>`;

const signal = new AbortController().signal;
const cleanup = (): EngineCleanupContext => ({ signal, timeoutMs: 30_000 });
const operation = (): OperationContext => ({ signal, timeoutMs: 30_000, runId: 'app-log', attemptId: 'a', origin: 'test' });

describe('app log', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(PAGE);
      } else if (request.url === '/moving') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(MOVING);
      } else if (request.url === '/next' || request.url === '/tab' || request.url === '/embed') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><h1>${request.url}</h1>`);
      } else if (request.url === '/api/reset') {
        request.socket.destroy();
      } else if (request.url === '/api/todos') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{}');
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports console output, uncaught exceptions, and error responses, one line each', async () => {
    const surface = new PlaywrightSurface({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-app-log-'));
    const entries: AppLogEntry[] = [];
    try {
      await surface.init({ runId: 'app-log', targetName: 'web', projectRoot: artifactsDir, app: { site: '127.0.0.1' },
        env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace, appLog: (entry) => entries.push(entry) });
      const browser = createBrowserFixture(surface, {
        operation,
        app: { resolveUrl: (target: string) => new URL(target, url).href },
        timeouts: { test: 30_000, assertion: 5_000 },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
      } as unknown as EngineFixtureContext);
      await browser.goto('/');
      await expect.poll(() => entries.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(7);
      expect(entries).toEqual(expect.arrayContaining([
        { source: 'console', level: 'info', text: expect.stringMatching(/^ready \(at /) },
        { source: 'console', level: 'warning', text: expect.stringMatching(/^deprecated prop \(at http:\/\/127\.0\.0\.1:\d+\/:\d+\)$/) },
        { source: 'console', level: 'error', text: expect.stringMatching(/^failed to load todos /) },
        { source: 'network', level: 'error', text: `GET ${url}/api/todos 500 Internal Server Error` },
        { source: 'network', level: 'warning', text: `GET ${url}/api/missing 404 Not Found` },
        { source: 'error', level: 'error', text: expect.stringMatching(/^RangeError: render loop exceeded/) },
        { source: 'network', level: 'error', text: expect.stringMatching(new RegExp(`^GET ${url}/api/reset net::ERR_`)) },
      ]));
      expect(entries).toHaveLength(7);
      expect(entries.some((entry) => entry.text.startsWith('Failed to load resource'))).toBe(false);
    } finally {
      await surface.endAttempt(cleanup()).catch(() => undefined);
      await surface.dispose(cleanup());
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it('tells where the page went, apart from its own navigations, the screen each action left, and the browser', async () => {
    const surface = new PlaywrightSurface({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-app-log-'));
    const entries: AppLogEntry[] = [];
    const screens: EngineSnapshot[] = [];
    const facts: Record<string, string>[] = [];
    try {
      await surface.init({ runId: 'app-log', targetName: 'web', projectRoot: artifactsDir, app: { site: '127.0.0.1' },
        env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await surface.startAttempt({
        attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets,
        appLog: (entry) => entries.push(entry),
        screen: (snapshot) => screens.push(snapshot),
        environment: (told) => facts.push({ ...told }),
      });
      await surface.open(`${url}/moving`, operation());
      expect(screens).toHaveLength(1);
      expect(screens[0]!.location).toBe(`${url}/moving`);
      // The screen is the trace's, never published: a ref from the observation acts after it, twice.
      const observed = await surface.observe(operation());
      const help = observed.root.children?.find((node) => node.role === 'button');
      await surface.perform(help!.ref, { kind: 'tap' }, operation());
      await surface.perform(help!.ref, { kind: 'tap' }, operation());
      expect(screens).toHaveLength(3);
      const navigations = () => entries.filter((entry) => entry.source === 'navigation').map((entry) => entry.text);
      await expect.poll(navigations, { timeout: 5_000 }).toContain(`navigated to ${url}/next`);
      expect(navigations()).toEqual(expect.arrayContaining([
        `frame "pay" loaded ${url}/embed`,
        `the app opened a new tab at ${url}/tab; the test stays on its page`,
      ]));
      expect(navigations().some((text) => text.includes('/moving'))).toBe(false);
      expect(navigations().some((text) => text.startsWith('the new tab navigated'))).toBe(false);
      await expect.poll(() => facts.length, { timeout: 5_000 }).toBe(1);
      expect(facts[0]).toEqual({ browser: expect.stringMatching(/^chromium \d+\./), 'user agent': expect.stringContaining('Chrome/') });
    } finally {
      await surface.endAttempt(cleanup()).catch(() => undefined);
      await surface.dispose(cleanup());
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
