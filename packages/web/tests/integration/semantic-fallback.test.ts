/**
 * A semantic reader that stalls leaves the observation masked pixels in time:
 * the fallback reserves capture time, takes fresh pixels with every secure
 * field covered, retires old refs, and never reuses an id the abandoned read
 * handed out. The reader is stalled at the BiDi transport, so the page itself
 * keeps painting.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { BidiConnection } from '../../src/bidi/connection.ts';
import { readerCall } from '../../src/bidi/readers.ts';
import { decodePng } from '../helpers/png.ts';
import { byTestId, startWebSession, type WebSession } from '../helpers/web-session.ts';

/** Every semantic ref, including nested documents. */
function nodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

/** Holds every tree read's reply until `release` runs; the read itself runs in the page. */
function stallTreeReads(): { release: () => void } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const send = BidiConnection.prototype.send;
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
    const reply = send.call(this, method, params);
    const declaration = (params as { functionDeclaration?: unknown }).functionDeclaration;
    if (method !== 'script.callFunction' || declaration !== readerCall('tree')) return reply;
    return released.then(() => reply);
  });
  return { release };
}

const sessions: WebSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe('masked fallback after a stalled semantic reader', () => {
  // Missing in BiDi: no masked pixel fallback (pixelFallback, treeUnavailable) when the semantic reader stalls.
  it.skip('reserves capture time and takes fresh masked pixels', async () => {
    const page = await startWebSession({ timeoutMs: 2_000 });
    sessions.push(page);
    const operation = { ...page.op(2_000), origin: 'agent' as const };
    await page.setContent('<style>input{position:absolute;left:20px;top:20px;width:100px;height:30px;border:0;padding:0;background:red}</style><input data-testid="password" type="password" value="private-value">');
    const old = await page.engine.observe!(operation);
    const [password] = await page.locate(byTestId('password'));
    expect(password).toBeDefined();
    await page.browser.evaluate(() => { setTimeout(() => { document.body.style.background = 'blue'; }, 1_000); return null; });
    stallTreeReads();
    const started = Date.now();
    const fallback = await page.engine.observe!(operation, { pixels: true, pixelFallback: true });
    expect(Date.now() - started).toBeGreaterThan(1_250);
    expect(Date.now() - started).toBeLessThan(operation.timeoutMs);
    expect(fallback.treeUnavailable).toBe(true);
    expect(fallback.root).toEqual({ ref: { id: old.root.ref.id, revision: '' } });
    expect(fallback.maskedRegionCount).toBeGreaterThanOrEqual(1);
    const image = decodePng(fallback.pixels!.data);
    expect(image.pixelAt(40, 30)).toEqual([0, 0, 0, 255]);
    expect(image.pixelAt(200, 100)).toEqual([0, 0, 255, 255]);
    await expect(page.engine.perform!(password!.ref, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  // Missing in BiDi: no masked pixel fallback (pixelFallback, treeUnavailable) when the semantic reader stalls.
  it.skip('keeps abandoned reader IDs distinct from new nodes, frames, and located refs', async () => {
    const page = await startWebSession({ timeoutMs: 5_000 });
    sessions.push(page);
    const operation = { ...page.op(5_000), origin: 'agent' as const };
    await page.setContent('<button data-testid="a" onclick="document.body.dataset.clicked=\'A\'">Button A</button>');
    await page.engine.observe!(operation);
    await page.browser.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Button B';
      button.addEventListener('click', () => { document.body.dataset.clicked = 'B'; });
      document.body.append(button);
      return null;
    });
    // The real reader stamps B; only its protocol reply is held.
    const stall = stallTreeReads();
    try {
      const fallback = await page.engine.observe!({ ...operation, timeoutMs: 2_000 }, { pixelFallback: true });
      expect(fallback.treeUnavailable).toBe(true);
    } finally {
      vi.restoreAllMocks();
      stall.release();
    }
    const [located] = await page.locate(byTestId('a'));
    await page.browser.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Button C';
      button.addEventListener('click', () => { document.body.dataset.clicked = 'C'; });
      document.body.prepend(button);
      const frame = document.createElement('iframe');
      frame.srcdoc = '<button onclick="document.body.dataset.clicked=\'D\'">Button D</button>';
      document.body.append(frame);
      return null;
    });
    await page.waitForFrames();
    const fresh = await page.engine.observe!(operation);
    const observed = nodes(fresh.root);
    const ids = observed.map((node) => node.ref.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(located).toBeDefined();
    expect(ids).not.toContain(located!.ref.id);
    for (const name of ['Button B', 'Button C', 'Button D']) {
      const target = observed.find((node) => node.name === name);
      expect(target, name).toBeDefined();
      await page.engine.perform!(target!.ref, { kind: 'tap' }, operation);
      const clicked = await page.browser.evaluate((inFrame: boolean) => {
        const body = inFrame ? document.querySelector('iframe')!.contentDocument!.body : document.body;
        return body.dataset.clicked ?? null;
      }, name === 'Button D');
      expect(clicked).toBe(name.slice(-1));
    }
  });
});
