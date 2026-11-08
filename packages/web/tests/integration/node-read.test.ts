/** Computed node properties come from real elements, including frames and shadow roots. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComputedStyleProperty, EngineHandle, OperationContext, SemanticNode } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { RefRegistry } from '../../src/refs.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 10_000, runId: 'read', attemptId: 'read-1', origin: 'agent' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 10_000 });

/** Finds a listed node by its accessible name. */
function named(tree: SemanticNode, name: string): SemanticNode | undefined {
  if (tree.name === name) return tree;
  for (const child of tree.children ?? []) {
    const found = named(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('computed node style', () => {
  let engine: EngineHandle;
  let artifactsDir: string;
  beforeAll(async () => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-node-read-'));
    engine = web();
    await engine.init!({ runId: 'read', targetName: 'web', projectRoot: process.cwd(), app: { site: 'example.test' }, env: {}, headed: false, workerSlot: 0, log: () => {}, signal: new AbortController().signal });
    await engine.startAttempt!({ attemptId: 'read-1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation());
  });
  afterAll(async () => {
    await engine?.endAttempt?.(cleanup());
    await engine?.dispose?.(cleanup());
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reads current computed values of an observed node without changing the page', async () => {
    const page = surfaceOf(engine)!.page();
    await page.setContent('<style>button { color: rgb(255, 0, 0); font-weight: 700; opacity: .5 }</style><button>Error</button>');
    const snapshot = await engine.observe!(operation());
    const ref = named(snapshot.root, 'Error')!.ref;
    const properties = ['color', 'font-weight', 'opacity', 'visibility'] as const;
    await expect(engine.readStyle!(ref, properties, operation())).resolves.toEqual({
      color: 'rgb(255, 0, 0)', 'font-weight': '700', opacity: '0.5', visibility: 'visible',
    });
    await page.locator('button').evaluate((element) => { element.style.color = 'blue'; });
    await expect(engine.readStyle!(ref, ['color'], operation())).resolves.toEqual({ color: 'rgb(0, 0, 255)' });
    expect(await page.locator('button').textContent()).toBe('Error');
    await page.locator('button').evaluate((element) => element.remove());
    await expect(engine.readStyle!(ref, properties, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('keeps the element binding when a similar element replaces it', async () => {
    const page = surfaceOf(engine)!.page();
    await page.setContent('<button>Original</button>');
    const old = named((await engine.observe!(operation())).root, 'Original')!.ref;
    await page.locator('button').evaluate((element) => { element.outerHTML = '<button>Original</button>'; });
    await expect(engine.readStyle!(old, ['color'], operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    const current = named((await engine.observe!(operation())).root, 'Original')!.ref;
    await expect(engine.readStyle!(old, ['color'], operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(engine.readStyle!(current, ['display'], operation())).resolves.toEqual({ display: 'inline-block' });
  });

  it('reads styles in a closed shadow root and rejects unsafe properties before resolving a ref', async () => {
    const page = surfaceOf(engine)!.page();
    await page.setContent('<x-message></x-message>');
    await page.evaluate(() => {
      document.querySelector('x-message')!.attachShadow({ mode: 'closed' }).innerHTML = '<button style="color: rgb(1, 2, 3)">Shadow error</button>';
    });
    const ref = named((await engine.observe!(operation())).root, 'Shadow error')!.ref;
    await expect(engine.readStyle!(ref, ['color'], operation())).resolves.toEqual({ color: 'rgb(1, 2, 3)' });
    for (const style of [['content'], ['background-image'], ['--token']]) {
      await expect(engine.readStyle!({ id: 'absent', revision: '' }, style as ComputedStyleProperty[], operation()))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    const controller = new AbortController();
    controller.abort();
    await expect(engine.readStyle!(ref, ['color'], { ...operation(), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('uses the owning document for a node in a same-site frame', async () => {
    const page = surfaceOf(engine)!.page();
    await page.route('http://example.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<iframe title="Error frame" srcdoc="<button style=\'color: rgb(4, 5, 6)\'>Framed error</button>"></iframe>',
    }));
    await page.goto('http://example.test/');
    const ref = named((await engine.observe!(operation())).root, 'Framed error')!.ref;
    await expect(engine.readStyle!(ref, ['color'], operation())).resolves.toEqual({ color: 'rgb(4, 5, 6)' });
  });

  it('does not evaluate a node if cancellation arrives during reference lookup', async () => {
    const page = surfaceOf(engine)!.page();
    await page.setContent('<button>Cancelled read</button>');
    const ref = named((await engine.observe!(operation())).root, 'Cancelled read')!.ref;
    const controller = new AbortController();
    const lookup = RefRegistry.prototype.lookup;
    let evaluated = false;
    const resolve = vi.spyOn(RefRegistry.prototype, 'lookup').mockImplementationOnce(async function (this: RefRegistry, target) {
      const resolved = await lookup.call(this, target);
      if (resolved.kind !== 'element') throw new Error('expected an observed element');
      const evaluate = resolved.element.evaluate.bind(resolved.element);
      vi.spyOn(resolved.element, 'evaluate').mockImplementation((...args) => {
        evaluated = true;
        return evaluate(...args);
      });
      controller.abort();
      return resolved;
    });
    try {
      await expect(engine.readStyle!(ref, ['color'], { ...operation(), signal: controller.signal }))
        .rejects.toMatchObject({ code: 'CANCELLED' });
      expect(evaluated).toBe(false);
    } finally { resolve.mockRestore(); }
  });

  it('reports a navigation that replaces a resolved node as retryable NODE_STALE', async () => {
    const page = surfaceOf(engine)!.page();
    await page.setContent('<button>Before navigation</button>');
    const ref = named((await engine.observe!(operation())).root, 'Before navigation')!.ref;
    const lookup = RefRegistry.prototype.lookup;
    const resolve = vi.spyOn(RefRegistry.prototype, 'lookup').mockImplementationOnce(async function (this: RefRegistry, target) {
      const resolved = await lookup.call(this, target);
      await page.reload();
      return resolved;
    });
    try {
      await expect(engine.readStyle!(ref, ['color'], operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    } finally { resolve.mockRestore(); }
  });
});
