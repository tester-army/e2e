/**
 * Init scripts: the configured `initScripts` and `browser.addInitScript` run
 * in every document before its own scripts, in order, in new tabs and
 * frames, and again on each context the attempt replaces. Each page here
 * records, from its first inline script, the trail the init scripts left.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secrets } from 'e2e';
import type { EngineCleanupContext, EngineHandle } from 'e2e/engine';
import type { Browser } from '../../src/fixture/types.ts';
import { web, type WebOptions } from '../../src/index.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

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

describe('init scripts', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-'));

  beforeAll(async () => {
    writeFileSync(path.join(projectRoot, 'from-file.js'), "(window.trail ??= []).push('file');\n");
  });

  afterAll(async () => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Boots one worker with `options` and runs `body` in one attempt with its `browser` fixture. */
  async function attempt(options: WebOptions, body: (browser: Browser, session: WebSession) => Promise<void>): Promise<void> {
    const session = await startWebSession({ web: options, projectRoot, secrets: { key: 'init-script-key' } });
    try {
      for (const [pathname, html] of Object.entries(PAGES)) session.serve(pathname, html);
      await body(session.browser, session);
    } finally {
      await session.close();
    }
  }

  /** What the page's frame, or the tab `window.open` returned, saw at boot, read from the top document. */
  const seenAtBootOf = (browser: Browser, target: 'frame' | 'tab') => browser.evaluate(async (where: string) => {
    const view = where === 'frame' ? document.querySelector('iframe')!.contentWindow! : Reflect.get(window, 'tab') as Window;
    while (view.document.readyState !== 'complete' || view.location.href === 'about:blank') await new Promise((resolve) => setTimeout(resolve, 20));
    return (view as Window & { seenAtBoot?: string[] }).seenAtBoot ?? null;
  }, target);

  const seenAtBoot = (browser: Browser) => browser.evaluate(() => window.seenAtBoot ?? null);

  it('runs the configured scripts in order before the page, in frames, new tabs, and replaced contexts', async () => {
    const initScripts: WebOptions['initScripts'] = [
      "(window.trail ??= []).push('source');",
      { path: 'from-file.js' },
      () => { (window.trail ??= []).push('function'); },
      { method() { (window.trail ??= []).push('method'); } }.method,
    ];
    await attempt({ initScripts }, async (browser, session) => {
      const expected = ['source', 'file', 'function', 'method'];
      await browser.goto('/framed');
      expect(await seenAtBoot(browser)).toEqual(expected);
      expect(await seenAtBootOf(browser, 'frame')).toEqual(expected);

      await browser.evaluate((target: string) => { Reflect.set(window, 'tab', window.open(target)); return null; }, `${session.origin}/`);
      expect(await seenAtBootOf(browser, 'tab')).toEqual(expected);

      await session.engine.session!.reset!(session.op());
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual(expected);
    });
  });

  it('adds a test script after the configured ones, from the next document on, for the rest of the attempt', async () => {
    await attempt({ initScripts: ["(window.trail ??= []).push('config');"] }, async (browser, session) => {
      await browser.goto('/');
      await browser.addInitScript((wallet) => { (window.trail ??= []).push(`wallet:${wallet.address}`); }, { address: '0xabc' });
      expect(await seenAtBoot(browser)).toEqual(['config']);
      await browser.reload();
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc']);

      const arg = JSON.parse('{"__proto__":{"own":true}}') as { __proto__: { own: boolean } };
      await browser.addInitScript((value) => {
        (window.trail ??= []).push(`own __proto__:${String(Object.hasOwn(value, '__proto__'))}`);
      }, arg);
      await browser.addInitScript({ path: 'from-file.js' });
      await session.engine.session!.reset!(session.op());
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc', 'own __proto__:true', 'file']);
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
    const surface: EngineHandle = web({ initScripts: [{ path: 'nope.js' }] });
    await expect(surface.prepare!({ runId: 'init-scripts', targetName: 'web', projectRoot, app: {}, slots: 1, env: {},
      signal, headed: false, log: () => undefined })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/nope\.js \(ENOENT\)/) });
    await expect(surface.init!({ runId: 'init-scripts', targetName: 'web', projectRoot, app: {}, env: {}, headed: false,
      workerSlot: 0, signal, log: () => undefined })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(/web\(\{ initScripts \}\)\[0\] path cannot be read: .*nope\.js \(ENOENT\)/),
    });
    await surface.dispose!(cleanup());
  });
});
