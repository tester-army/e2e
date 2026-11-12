/**
 * Tabs in a real browser: a tab the app opens joins the tabs in the
 * background, `waitForPopup` and `switchTab` show one, and when the shown tab
 * closes, the tab that opened it is shown again. Driven through the engine
 * hooks the harness and the agent use, and the `browser` fixture's tab calls.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, EngineSnapshot, OperationContext, SemanticNode } from 'e2e/engine';
import { web, type Browser } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const PAGES: Readonly<Record<string, string>> = {
  '/opener': `<!doctype html><title>Opener</title><h1>Opener</h1>
    <button onclick="window.open('/popup', '_blank')">Open window</button>
    <a href="/popup" target="_blank">Open link</a>
    <button onclick="const tab = window.open('', '_blank'); tab.document.write('<title>Written</title><p>Code TAB-88421</p>'); tab.document.close();">Write tab</button>
    <a href="/slow" target="_blank">Open slow</a>
    <a href="/hang" target="_blank">Open hang</a>
    <a href="/no-content" target="_blank">Open nothing</a>
    <a href="mailto:help@example.com" target="_blank">Email us</a>
    <a href="/export" target="_blank">Export</a>
    <button onclick="const tab = window.open('/popup', '_blank'); setTimeout(() => tab.close(), 400);">Open briefly</button>`,
  '/popup': `<!doctype html><title>Popup</title><h1>Popup</h1>
    <button onclick="window.close()">Close me</button>
    <button onclick="window.open('/nested', '_blank')">Open nested</button>
    <button onclick="window.open('/slow', '_blank'); window.close();">Hand off</button>`,
  '/nested': '<!doctype html><title>Nested</title><h1>Nested</h1><button onclick="window.close()">Close nested</button>',
  '/slow': '<!doctype html><title>Slow</title><h1>Slow</h1>',
};

const HEADING = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } } as const;

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(timeoutMs = 30_000): OperationContext {
  return { signal: new AbortController().signal, timeoutMs, runId: 'run-tabs', attemptId: 't1', origin: 'test' };
}

/** Every node of a snapshot, depth first. */
function nodesOf(snapshot: EngineSnapshot): SemanticNode[] {
  const nodes: SemanticNode[] = [];
  const walk = (node: SemanticNode): void => {
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(snapshot.root);
  return nodes;
}

describe('tabs', () => {
  let server: Server;
  let url: string;
  let artifactsDir: string;
  /** Requests for `/hang`, answered only when a test lets them go. */
  const hanging = new Set<ServerResponse>();

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/hang') {
        hanging.add(response);
        return;
      }
      if (request.url === '/no-content') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === '/export') {
        response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' });
        response.end('a,b\n');
        return;
      }
      const page = PAGES[request.url ?? ''];
      if (request.url === '/slow') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(page);
        }, 1_500);
        return;
      }
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html' });
      response.end(page ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-tabs-'));
  });

  afterAll(async () => {
    for (const response of hanging) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Runs `body` on one engine in a running attempt opened at `/opener`, with the `browser` fixture. */
  async function withAttempt(body: (engine: EngineHandle, browser: Browser) => Promise<void>): Promise<void> {
    const engine = web({});
    await engine.init!({
      runId: 'run-tabs', targetName: 'web', projectRoot: process.cwd(),
      app: { site: '127.0.0.1' }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 't1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    try {
      const browser = engine.fixtures!['browser']!({
        operation,
        app: { resolveUrl: (target: string) => new URL(target, url).href },
        timeouts: { test: 30_000, assertion: 5_000 },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
        attachArtifact: () => undefined,
      } as unknown as EngineFixtureContext) as Browser;
      await engine.session!.open!(`${url}/opener`, operation());
      await body(engine, browser);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  }

  /** Taps the node the current screen names `name`. */
  async function tap(engine: EngineHandle, name: string): Promise<void> {
    const node = nodesOf(await engine.observe!(operation())).find((candidate) => candidate.name === name);
    if (node === undefined) throw new Error(`no node named ${name} on the screen`);
    await engine.perform!(node.ref, { kind: 'tap' }, operation());
  }

  /** The screen's location and tabs, once its location ends with `suffix`. */
  async function screenAt(engine: EngineHandle, suffix: string): Promise<EngineSnapshot> {
    let snapshot: EngineSnapshot | undefined;
    await expect.poll(async () => {
      snapshot = await engine.observe!(operation());
      return snapshot.location ?? '';
    }, { timeout: 10_000 }).toMatch(new RegExp(`${suffix}$`));
    return snapshot!;
  }

  /** The screen once the attempt has `count` tabs open. */
  async function withTabs(engine: EngineHandle, count: number): Promise<EngineSnapshot> {
    let snapshot: EngineSnapshot | undefined;
    await expect.poll(async () => {
      snapshot = await engine.observe!(operation());
      return snapshot.tabs?.count ?? 1;
    }, { timeout: 10_000 }).toBe(count);
    return snapshot!;
  }

  it('a tab the app opens stays in the background until it is switched to, and its close shows its opener', async () => {
    await withAttempt(async (engine) => {
      await tap(engine, 'Open window');
      const opened = await withTabs(engine, 2);
      expect(opened.location).toBe(`${url}/opener`);
      expect(opened.tabs).toEqual({ count: 2, active: 0 });
      await engine.session!.switchTab!(1, operation());
      expect((await screenAt(engine, '/popup')).tabs).toEqual({ count: 2, active: 1 });
      // The tap's only effect is closing the page it tapped on.
      await tap(engine, 'Close me');
      const back = await screenAt(engine, '/opener');
      expect(back.tabs).toBeUndefined();
    });
  });

  it('an operation after a tap that opens a slow tab runs on the opener at once; waitForPopup waits for the page', async () => {
    await withAttempt(async (engine, browser) => {
      await tap(engine, 'Open slow');
      const started = Date.now();
      expect((await engine.observe!(operation())).location).toBe(`${url}/opener`);
      expect(Date.now() - started).toBeLessThan(1_000);
      // It joins in the background once its page loads.
      expect((await withTabs(engine, 2)).tabs).toEqual({ count: 2, active: 0 });
      const slow = await browser.waitForPopup(() => tap(engine, 'Open slow'));
      expect(await slow.url()).toBe(`${url}/slow`);
      expect((await engine.observe!(operation())).tabs).toEqual({ count: 3, active: 2 });
    });
  });

  it('waitForPopup names the page a tab could not load when its time runs out, and the opener still answers', async () => {
    await withAttempt(async (engine, browser) => {
      await expect(browser.waitForPopup(() => tap(engine, 'Open hang'), { timeout: 1_000 })).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: `the tab the app opened did not load ${url}/hang within 1000ms`,
      });
      expect(await browser.title()).toBe('Opener');
      for (const response of hanging) response.destroy();
      hanging.clear();
    });
  });

  it('a tab whose opener closed itself before the tab loaded joins the tabs', async () => {
    await withAttempt(async (engine, browser) => {
      await browser.waitForPopup(() => tap(engine, 'Open window'));
      const orphan = await browser.waitForPopup(() => tap(engine, 'Hand off'));
      expect(await orphan.url()).toBe(`${url}/slow`);
      expect(orphan.isActive()).toBe(true);
      expect(browser.tabs()).toHaveLength(2);
      // It has no opener left, so its close hands the screen to the tab shown before it.
      await orphan.close();
      expect(await browser.url()).toBe(`${url}/opener`);
    });
  });

  it('a tab that never gets a document never joins the tabs', async () => {
    await withAttempt(async (engine, browser) => {
      for (const link of ['Open nothing', 'Email us', 'Export']) {
        await tap(engine, link);
        const started = Date.now();
        const snapshot = await engine.observe!(operation());
        expect(snapshot.location, link).toBe(`${url}/opener`);
        expect(Date.now() - started, link).toBeLessThan(1_000);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(browser.tabs(), link).toHaveLength(1);
        expect((await engine.observe!(operation())).tabs, link).toBeUndefined();
      }
    });
  });

  it('reads in flight when the app closes the shown tab repeat on the tab shown next', async () => {
    await withAttempt(async (engine, browser) => {
      await browser.waitForPopup(() => tap(engine, 'Open briefly'));
      await screenAt(engine, '/popup');
      // A retryable stale read is the runner's to repeat, as the locator engine does.
      const repeated = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await read();
        } catch (cause) {
          expect(cause).toMatchObject({ code: 'NODE_STALE', retryable: true, message: 'the tab closed while it was read' });
          return undefined;
        }
      };
      const until = Date.now() + 1_500;
      const locations = new Set<string>();
      while (Date.now() < until) {
        const [snapshot] = await Promise.all([
          repeated(() => engine.observe!(operation())),
          repeated(() => engine.locate!(HEADING, operation())),
        ]);
        if (snapshot !== undefined) locations.add(snapshot.location ?? '');
      }
      expect([...locations]).toEqual([`${url}/popup`, `${url}/opener`]);
    });
  });

  it('a target="_blank" link opens a tab, and a tab the app wrote with no navigation reads once switched to', async () => {
    await withAttempt(async (engine) => {
      await tap(engine, 'Open link');
      await withTabs(engine, 2);
      await tap(engine, 'Write tab');
      expect((await withTabs(engine, 3)).tabs).toEqual({ count: 3, active: 0 });
      await engine.session!.switchTab!(2, operation());
      await expect.poll(async () => nodesOf(await engine.observe!(operation())).some((node) => node.text === 'Code TAB-88421'), { timeout: 10_000 }).toBe(true);
      expect((await engine.observe!(operation())).tabs).toEqual({ count: 3, active: 2 });
    });
  });

  it('waitForPopup resolves with the tab once it is active; activate and close move between tabs', async () => {
    await withAttempt(async (_engine, browser) => {
      const popup = await browser.waitForPopup(async () => { await browser.evaluate("document.querySelector('a').click()"); });
      expect(popup.isActive()).toBe(true);
      expect(await popup.url()).toBe(`${url}/popup`);
      expect(await browser.url()).toBe(`${url}/popup`);
      const [opener, second] = browser.tabs();
      expect(second).toBe(popup);
      await opener!.activate();
      expect(await browser.title()).toBe('Opener');
      expect(popup.isActive()).toBe(false);
      await popup.activate();
      expect(await browser.title()).toBe('Popup');
      await popup.close();
      expect(popup.isClosed()).toBe(true);
      expect(opener!.isActive()).toBe(true);
      expect(await browser.url()).toBe(`${url}/opener`);
      expect(browser.tabs()).toEqual([opener]);
      await expect(popup.activate()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    });
  });

  it('waitForPopup fails the wait when no tab opens', async () => {
    await withAttempt(async (_engine, browser) => {
      await expect(browser.waitForPopup(async () => undefined, { timeout: 500 })).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringMatching(/^no tab opened within 500ms/),
      });
      expect(browser.tabs()).toHaveLength(1);
    });
  });

  it('switchTab and closeTab take a tab by its place in opening order and refuse one that is not open', async () => {
    await withAttempt(async (engine) => {
      await tap(engine, 'Open window');
      await withTabs(engine, 2);
      await engine.session!.switchTab!(1, operation());
      expect((await screenAt(engine, '/popup')).tabs).toEqual({ count: 2, active: 1 });
      await expect(engine.session!.switchTab!(2, operation())).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringContaining('there is no tab 3: 2 tabs are open'),
      });
      // Closing the tab on screen shows its opener.
      await engine.session!.closeTab!(1, operation());
      expect((await engine.observe!(operation())).location).toBe(`${url}/opener`);
      await expect(engine.session!.closeTab!(0, operation())).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringContaining('tab 1 is the only open tab'),
      });
      // Closing a tab in the background leaves the screen where it is.
      await tap(engine, 'Open window');
      await withTabs(engine, 2);
      await engine.session!.closeTab!(1, operation());
      const after = await engine.observe!(operation());
      expect(after.location).toBe(`${url}/opener`);
      expect(after.tabs).toBeUndefined();
    });
  });

  it('a tab closed out of order hands the screen to its nearest open opener', async () => {
    await withAttempt(async (engine, browser) => {
      const middle = await browser.waitForPopup(async () => { await browser.evaluate("document.querySelector('a').click()"); });
      const last = await browser.waitForPopup(async () => { await browser.evaluate("document.querySelectorAll('button')[1].click()"); });
      expect(await browser.url()).toBe(`${url}/nested`);
      // The tab in the middle closes in the background: the screen stays where it is.
      await middle.close();
      expect(last.isActive()).toBe(true);
      expect(browser.tabs()).toHaveLength(2);
      // The shown tab closes and its opener is gone: the screen returns to the opener's opener.
      await tap(engine, 'Close nested');
      await screenAt(engine, '/opener');
      expect(browser.tabs()).toHaveLength(1);
    });
  });

  it('newTab opens a blank tab in the same context and shows it', async () => {
    await withAttempt(async (_engine, browser) => {
      await browser.evaluate("document.cookie = 'shared=yes'");
      const tab = await browser.newTab();
      expect(tab.isActive()).toBe(true);
      expect(await browser.url()).toBe('about:blank');
      await browser.goto('/nested');
      expect(await browser.evaluate('document.cookie')).toBe('shared=yes');
      expect(browser.tabs()).toHaveLength(2);
    });
  });

  it('the video keeps a segment per tab shown and drops the one a tab that closed itself could not flush', async () => {
    await withAttempt(async (engine, browser) => {
      await engine.artifacts!.startVideo!(operation());
      await browser.waitForPopup(() => tap(engine, 'Open window'));
      await screenAt(engine, '/popup');
      await tap(engine, 'Close me');
      await screenAt(engine, '/opener');
      const segments = await engine.artifacts!.stopVideo!(operation());
      const files = segments.map((segment) => ('path' in segment ? segment.path : segment.url));
      expect(files[0]).toBe('video/video.webm');
      expect(files.at(-1)).toBe('video/video-part3.webm');
      for (const file of files) {
        const absolute = path.join(artifactsDir, file);
        expect(existsSync(absolute), file).toBe(true);
        expect(statSync(absolute).size).toBeGreaterThan(0);
      }
    });
  });
});
