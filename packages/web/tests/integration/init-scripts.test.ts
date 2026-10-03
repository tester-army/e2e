/**
 * Init scripts: the configured `initScripts` and `browser.addInitScript` run
 * in every document before its own scripts, in order, in new tabs and
 * frames, and again on each context the attempt replaces. Each page here
 * records, from its first inline script, the trail the init scripts left.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secrets } from 'e2e';
import type { EngineCleanupContext, EngineFixtureContext, OperationContext } from 'e2e/engine';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { PlaywrightSurface, type WebOptions } from '../../src/surface.ts';
import { noSecrets } from '../helpers/secrets.ts';

declare global {
  interface Window {
    trail?: string[];
    seenAtBoot?: string[];
  }
}

const BOOT = '<script>window.seenAtBoot = [...(window.trail ?? [])];</script>';
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html><head>${BOOT}</head><body><h1>Home</h1></body></html>`,
  '/framed': `<!doctype html><html><head>${BOOT}</head><body><iframe src="/"></iframe></body></html>`,
};

const signal = new AbortController().signal;
const cleanup = (): EngineCleanupContext => ({ signal, timeoutMs: 30_000 });
const operation = (): OperationContext => ({ signal, timeoutMs: 30_000, runId: 'init-scripts', attemptId: 'a', origin: 'test' });

describe('init scripts', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-'));
  let server: Server;
  let url: string;

  beforeAll(async () => {
    writeFileSync(path.join(projectRoot, 'from-file.js'), "(window.trail ??= []).push('file');\n");
    server = createServer((request, response) => {
      const body = PAGES[request.url ?? ''];
      response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' });
      response.end(body ?? 'not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Boots one worker of a surface with `options` and runs `body` in one attempt with its `browser` fixture. */
  async function attempt(options: WebOptions, body: (browser: Browser, surface: PlaywrightSurface) => Promise<void>): Promise<void> {
    const surface = new PlaywrightSurface(options);
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-artifacts-'));
    try {
      await surface.init({ runId: 'init-scripts', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
        env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets });
      const browser = createBrowserFixture(surface, {
        operation,
        app: { resolveUrl: (target: string) => new URL(target, url).href },
        timeouts: { test: 30_000, assertion: 5_000 },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
      } as unknown as EngineFixtureContext);
      await body(browser, surface);
    } finally {
      await surface.endAttempt(cleanup()).catch(() => undefined);
      await surface.dispose(cleanup());
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }

  const seenAtBoot = (browser: Browser) => browser.evaluate(() => window.seenAtBoot ?? null);

  it('runs the configured scripts in order before the page, in frames, new tabs, and replaced contexts', async () => {
    const initScripts: WebOptions['initScripts'] = [
      "(window.trail ??= []).push('source');",
      { path: 'from-file.js' },
      () => { (window.trail ??= []).push('function'); },
    ];
    await attempt({ initScripts }, async (browser, surface) => {
      const expected = ['source', 'file', 'function'];
      await browser.goto('/framed');
      expect(await seenAtBoot(browser)).toEqual(expected);
      const frame = surface.requirePage().frames()[1]!;
      await frame.waitForLoadState();
      expect(await frame.evaluate(() => window.seenAtBoot)).toEqual(expected);

      const opened = surface.requireContext().waitForEvent('page');
      await browser.evaluate((target) => { window.open(target); return null; }, `${url}/`);
      const tab = await opened;
      await tab.waitForLoadState();
      expect(await tab.evaluate(() => window.seenAtBoot)).toEqual(expected);

      await surface.reset(operation());
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual(expected);
    });
  });

  it('adds a test script after the configured ones, from the next document on, for the rest of the attempt', async () => {
    await attempt({ initScripts: ["(window.trail ??= []).push('config');"] }, async (browser, surface) => {
      await browser.goto('/');
      await browser.addInitScript((wallet) => { (window.trail ??= []).push(`wallet:${wallet.address}`); }, { address: '0xabc' });
      expect(await seenAtBoot(browser)).toEqual(['config']);
      await browser.reload();
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc']);

      await browser.addInitScript({ path: 'from-file.js' });
      await surface.reset(operation());
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc', 'file']);
    });
    await attempt({}, async (browser) => {
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual([]);
    });
  });

  it('refuses a script it cannot run, and a secret argument', async () => {
    await attempt({}, async (browser) => {
      const add = browser.addInitScript as (...args: unknown[]) => Promise<void>;
      await expect(add('window.x = 1', 3)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/only with a function/) });
      await expect(add({ path: 'missing.js' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/missing\.js \(ENOENT\)/) });
      await expect(add({ content: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/takes only path, got content/) });
      await expect(add(42)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(add(() => undefined, secrets.get('key'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    });
  });

  it('fails the run, and a worker, with INVALID_CONFIG when a configured file cannot be read', async () => {
    const surface = new PlaywrightSurface({ initScripts: [{ path: 'nope.js' }] });
    await expect(surface.prepare({ runId: 'init-scripts', targetName: 'web', projectRoot, app: {}, slots: 1, env: {},
      signal, log: () => undefined })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/nope\.js \(ENOENT\)/) });
    await expect(surface.init({ runId: 'init-scripts', targetName: 'web', projectRoot, app: {}, env: {}, headed: false,
      workerSlot: 0, signal, log: () => undefined })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(/web\(\{ initScripts \}\)\[0\] path cannot be read: .*nope\.js \(ENOENT\)/),
    });
    await surface.dispose(cleanup());
  });
});
