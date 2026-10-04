/**
 * The app log: what a page does on its own during an attempt reaches the
 * harness as one line each, from a real browser: console errors and
 * warnings, exceptions nothing caught, requests that failed, and responses
 * with an error status. A console echo of a failed load and a request the
 * page abandoned are left out, so each event is one line.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppLogEntry, EngineCleanupContext, EngineFixtureContext, OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { noSecrets } from '../helpers/secrets.ts';

const PAGE = `<!doctype html><html><body><h1>Todos</h1><script>
  console.log('ready');
  console.warn('deprecated prop');
  console.error('failed to load todos');
  fetch('/api/todos');
  fetch('/api/missing');
  fetch('/api/reset').catch(() => undefined);
  setTimeout(() => { throw new RangeError('render loop exceeded'); }, 0);
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

  it('reports console errors and warnings, uncaught exceptions, and error responses, one line each', async () => {
    const surface = new PlaywrightSurface({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-app-log-'));
    const entries: AppLogEntry[] = [];
    try {
      await surface.init({ runId: 'app-log', targetName: 'web', projectRoot: artifactsDir, app: { site: '127.0.0.1' },
        env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, appLog: (entry) => entries.push(entry) });
      const browser = createBrowserFixture(surface, {
        operation,
        app: { resolveUrl: (target: string) => new URL(target, url).href },
        timeouts: { test: 30_000, assertion: 5_000 },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
      } as unknown as EngineFixtureContext);
      await browser.goto('/');
      await expect.poll(() => entries.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(6);
      expect(entries).toEqual(expect.arrayContaining([
        { source: 'console', level: 'warning', text: expect.stringMatching(/^deprecated prop \(at http:\/\/127\.0\.0\.1:\d+\/:\d+\)$/) },
        { source: 'console', level: 'error', text: expect.stringMatching(/^failed to load todos /) },
        { source: 'network', level: 'error', text: `GET ${url}/api/todos 500 Internal Server Error` },
        { source: 'network', level: 'warning', text: `GET ${url}/api/missing 404 Not Found` },
        { source: 'error', level: 'error', text: expect.stringMatching(/^RangeError: render loop exceeded/) },
        { source: 'network', level: 'error', text: expect.stringMatching(new RegExp(`^GET ${url}/api/reset net::ERR_`)) },
      ]));
      expect(entries).toHaveLength(6);
      expect(entries.some((entry) => entry.text.startsWith('ready'))).toBe(false);
      expect(entries.some((entry) => entry.text.startsWith('Failed to load resource'))).toBe(false);
    } finally {
      await surface.endAttempt(cleanup()).catch(() => undefined);
      await surface.dispose(cleanup());
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
