/**
 * Native dialogs no handler takes, in a real browser: after an agent step's
 * own action, live or replayed, the engine answers them the way the action
 * asked, so leaving a form with unsaved changes navigates and a confirm goes
 * through, and the app log names each one. A dialog belongs to the newest
 * action, never to a read: one a test's own step opened still fails the
 * next step, as an unhandled dialog always has.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppLogEntry, EngineCleanupContext, EngineFixtureContext, OperationContext, SemanticNode } from 'e2e/engine';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const PAGES: Readonly<Record<string, string>> = {
  '/form': `<!doctype html><html><body><h1>Edit</h1><input aria-label="Title"><script>
    document.querySelector('input').addEventListener('input', () => {
      window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = ''; };
    });
  </script></body></html>`,
  '/actions': `<!doctype html><html><body><h1>Labels</h1><p id="status" role="status">idle</p>
    <button onclick="document.querySelector('#status').textContent = confirm('Delete this label?') ? 'deleted' : 'kept'">Delete</button>
    <button onclick="const name = prompt('New name?'); document.querySelector('#status').textContent = name === null ? 'rename cancelled' : 'renamed ' + name">Rename</button>
    <button onclick="alert('Saved'); document.querySelector('#status').textContent = 'saved'">Save</button>
  </body></html>`,
  '/later': `<!doctype html><html><body><h1>Reports</h1><p id="status" role="status">idle</p>
    <button onclick="setTimeout(() => { document.querySelector('#status').textContent = confirm('Submit the report?') ? 'submitted' : 'kept'; }, 300)">Submit later</button>
    <button onclick="fetch('/api/save').then(() => { alert('Saved'); document.querySelector('#status').textContent = 'saved'; })">Save</button>
  </body></html>`,
  '/sync': `<!doctype html><html><body><h1>Sync</h1><p id="status" role="status">idle</p>
    <button onclick="document.querySelector('#status').textContent = 'marked'">Mark</button>
    <button onclick="fetch('/api/fail').catch(() => setTimeout(() => { alert('Synced'); document.querySelector('#status').textContent = 'synced'; }, 500))">Sync</button>
    <script>
      addEventListener('resize', () => setTimeout(() => {
        document.querySelector('#status').textContent = confirm('Keep the narrow layout?') ? 'kept narrow' : 'reverted';
      }, 0), { once: true });
    </script>
  </body></html>`,
  '/next': '<!doctype html><html><body><h1>Next</h1></body></html>',
  '/api/save': 'ok',
};

const signal = new AbortController().signal;
const cleanup = (): EngineCleanupContext => ({ signal, timeoutMs: 30_000 });
const operation = (origin: OperationContext['origin']): OperationContext => ({ signal, timeoutMs: 30_000, runId: 'dialogs', attemptId: 'a', origin });

/** Every node in document order. */
function nodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

describe('native dialogs no handler takes', () => {
  let server: Server;
  let url: string;
  let surface: PlaywrightSurface;
  let artifactsDir: string;
  let log: AppLogEntry[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const page = request.url === undefined ? undefined : PAGES[request.url];
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html' });
      response.end(page ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Opens one attempt, runs `body` in it with the attempt's `browser` fixture, and tears it down. */
  async function attempt(body: (browser: Browser) => Promise<void>): Promise<void> {
    surface = new PlaywrightSurface({});
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-agent-dialogs-'));
    log = [];
    try {
      await surface.init({ runId: 'dialogs', targetName: 'web', projectRoot: artifactsDir, app: { site: '127.0.0.1' },
        env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace, appLog: (entry) => log.push(entry) });
      await body(createBrowserFixture(surface, {
        operation: () => operation('test'),
        app: { resolveUrl: (target: string) => new URL(target, url).href },
        timeouts: { test: 30_000, assertion: 5_000 },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
        attachViewport: () => undefined,
      } as unknown as EngineFixtureContext));
    } finally {
      await surface.endAttempt(cleanup()).catch(() => undefined);
      await surface.dispose(cleanup());
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }

  /** The node `match` names on the current screen, observed as `origin`. */
  async function find(origin: OperationContext['origin'], match: (node: SemanticNode) => boolean): Promise<SemanticNode> {
    const found = nodes((await surface.observe(operation(origin))).root).find(match);
    if (found === undefined) throw new Error('no such node on the screen');
    return found;
  }

  const button = (name: string) => (node: SemanticNode) => node.role === 'button' && node.name === name;
  const status = async (origin: OperationContext['origin']) =>
    nodes((await surface.observe(operation(origin))).root).find((node) => node.role === 'status')?.text;

  it('lets the agent leave a form with unsaved changes', async () => {
    await attempt(async () => {
      await surface.open(`${url}/form`, operation('agent'));
      const title = await find('agent', (node) => node.role === 'textbox');
      await surface.perform(title.ref, { kind: 'tap' }, operation('agent'));
      await surface.perform(title.ref, { kind: 'fill', value: 'Draft', sensitive: false }, operation('agent'));
      await surface.open(`${url}/next`, operation('agent'));
      expect((await surface.observe(operation('agent'))).location).toBe(`${url}/next`);
      expect(log).toEqual([{ source: 'system', level: 'info', text: 'beforeunload dialog accepted for the agent' }]);
    });
  });

  it("answers the agent's confirm and alert, dismisses its prompt, and names each in the app log", async () => {
    await attempt(async () => {
      await surface.open(`${url}/actions`, operation('agent'));
      await surface.perform((await find('agent', button('Delete'))).ref, { kind: 'tap' }, operation('agent'));
      expect(await status('agent')).toBe('deleted');
      await surface.perform((await find('agent', button('Rename'))).ref, { kind: 'tap' }, operation('agent'));
      expect(await status('agent')).toBe('rename cancelled');
      await surface.perform((await find('agent', button('Save'))).ref, { kind: 'tap' }, operation('agent'));
      expect(await status('agent')).toBe('saved');
      expect(log.map((entry) => entry.text)).toEqual([
        'confirm dialog "Delete this label?" accepted for the agent',
        'prompt dialog "New name?" dismissed for the agent',
        'alert dialog "Saved" accepted for the agent',
      ]);
    });
  });

  it('answers a dialog a replayed agent step opens, though the replay acts with the test origin', async () => {
    await attempt(async () => {
      await surface.open(`${url}/actions`, operation('test'));
      const replayed: OperationContext = { ...operation('test'), agentStep: true };
      await surface.perform((await find('test', button('Delete'))).ref, { kind: 'tap' }, replayed);
      expect(await status('test')).toBe('deleted');
      expect(log.map((entry) => entry.text)).toEqual(['confirm dialog "Delete this label?" accepted for the agent']);
    });
  });

  it("keeps a dialog the agent's action opened the agent's while a test route handler fetches in between", async () => {
    await attempt(async (browser) => {
      await browser.route('**/api/save', async (route) => {
        const upstream = await route.fetch();
        await route.fulfill({ body: await upstream.text() });
      });
      await surface.open(`${url}/later`, operation('agent'));
      await surface.perform((await find('agent', button('Save'))).ref, { kind: 'tap' }, operation('agent'));
      await expect.poll(() => status('agent'), { timeout: 5_000 }).toBe('saved');
      expect(log.map((entry) => entry.text)).toEqual(['alert dialog "Saved" accepted for the agent']);
    });
  });

  it("fails a test's next step on a dialog its viewport change opened, though an agent acted before it", async () => {
    await attempt(async (browser) => {
      await surface.open(`${url}/sync`, operation('agent'));
      await surface.perform((await find('agent', button('Mark'))).ref, { kind: 'tap' }, operation('agent'));
      await browser.setViewport({ width: 500, height: 600 });
      await expect
        .poll(() => surface.observe(operation('agent')).then(() => 'read', (error: { code?: string }) => error.code), { timeout: 5_000 })
        .toBe('INVALID_STATE');
      expect(await status('test')).toBe('reverted');
      expect(log).toEqual([]);
    });
  });

  it('leaves a dialog with the agent when the next operation is refused before it runs', async () => {
    await attempt(async (browser) => {
      let failed!: () => void;
      const routed = new Promise<void>((resolve) => {
        failed = resolve;
      });
      await browser.route('**/api/fail', () => {
        failed();
        throw new Error('route handler failed on purpose');
      });
      await surface.open(`${url}/sync`, operation('agent'));
      await surface.perform((await find('agent', button('Sync'))).ref, { kind: 'tap' }, operation('agent'));
      await routed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The handler's failure is pending, so this test action is refused before it runs and takes no dialog.
      await expect(browser.evaluate('1')).rejects.toThrow(/route handler failed on purpose/);
      await expect.poll(() => status('agent'), { timeout: 5_000 }).toBe('synced');
      expect(log.filter((entry) => entry.source === 'system').map((entry) => entry.text)).toEqual(['alert dialog "Synced" accepted for the agent']);
    });
  });

  it("fails a test's next step on a dialog it opened late, though an agent read the page in between", async () => {
    await attempt(async () => {
      await surface.open(`${url}/later`, operation('test'));
      await surface.perform((await find('test', button('Submit later'))).ref, { kind: 'tap' }, operation('test'));
      // An agent judgment polling the screen reads; it takes no dialog for the agent.
      await surface.observe(operation('agent'));
      await expect
        .poll(() => surface.observe(operation('agent')).then(() => 'read', (error: { code?: string }) => error.code), { timeout: 5_000 })
        .toBe('INVALID_STATE');
      expect(await status('test')).toBe('kept');
      expect(log).toEqual([]);
    });
  });

  it("fails a test's next step on a dialog its own action opened, and dismisses the dialog", async () => {
    await attempt(async () => {
      await surface.open(`${url}/actions`, operation('test'));
      await surface.perform((await find('test', button('Delete'))).ref, { kind: 'tap' }, operation('test'));
      await expect(surface.observe(operation('test'))).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: expect.stringContaining('unhandled confirm dialog: Delete this label?'),
      });
      expect(await status('test')).toBe('kept');
      expect(log).toEqual([]);
    });
  });
});
