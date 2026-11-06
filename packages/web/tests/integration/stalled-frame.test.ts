/**
 * A frame whose first request is held shows its initial empty document. An
 * observation reads and screenshots the page around it without waiting for
 * that navigation to commit.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebRoute } from '../../src/fixture/types.ts';
import { decodePng } from '../helpers/png.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let session: WebSession;
const held: { route: WebRoute; release: () => void }[] = [];

beforeAll(async () => {
  session = await startWebSession({ web: { viewport: { width: 320, height: 200 } }, startAttempt: false });
  session.serve('/', '<!doctype html><title>Host</title><h1>Host</h1>');
});

beforeEach(async () => {
  await session.startAttempt();
});

afterEach(async () => {
  for (const { route, release } of held.splice(0)) {
    await route.abort().catch(() => undefined);
    release();
  }
  await session.endAttempt();
});

afterAll(async () => {
  await session.close();
});

/** Opens a page holding an iframe whose request for `/held.html` never gets an answer. */
async function pageWithHeldFrame(attributes = ''): Promise<void> {
  let routed!: () => void;
  const routeReady = new Promise<void>((resolve) => (routed = resolve));
  await session.browser.route('**/held.html', (route) => new Promise<void>((release) => {
    held.push({ route, release });
    routed();
  }));
  await session.open(`${session.origin}/`);
  await session.browser.evaluate((extra: string) => {
    document.body.insertAdjacentHTML('beforeend', `<iframe ${extra} src="/held.html"></iframe>`);
    return null;
  }, attributes);
  await routeReady;
}

/** One agent observation with pixels. */
const observeWithPixels = () => session.engine.observe!({ ...session.op(5_000), origin: 'agent' }, { pixels: true });

describe('a frame whose navigation is held', () => {
  it('leaves the observation whole and its pixels masked', async () => {
    await pageWithHeldFrame();
    const snapshot = await observeWithPixels();
    expect(snapshot.pixels?.width).toBe(320);
    expect(snapshot.truncated).toBeUndefined();
    expect(snapshot.maskedRegionCount).toBe(0);
  });

  it('masks a secure field the parent wrote into the initial document', async () => {
    await pageWithHeldFrame();
    const center = await session.browser.evaluate(() => {
      const frame = document.querySelector('iframe')!;
      frame.contentDocument!.body.innerHTML = '<input type="password" value="hunter2" style="background:red;border:0;width:60px;height:20px">';
      const outer = frame.getBoundingClientRect();
      const inner = frame.contentDocument!.querySelector('input')!.getBoundingClientRect();
      return { x: Math.round(outer.left + frame.clientLeft + inner.left + inner.width / 2), y: Math.round(outer.top + frame.clientTop + inner.top + inner.height / 2) };
    });
    const snapshot = await observeWithPixels();
    expect(snapshot.maskedRegionCount).toBe(1);
    const image = decodePng(snapshot.pixels!.data);
    // The field's own red never shows: the mask covers it, at its place inside the uncommitted frame.
    expect(image.pixelAt(center.x, center.y)).toEqual([0, 0, 0, 255]);
    expect(image.pixelAt(300, 5)).toEqual([255, 255, 255, 255]);
  });

  it('captures past a sandboxed frame no script can reach', async () => {
    await pageWithHeldFrame('sandbox');
    const snapshot = await observeWithPixels();
    expect(snapshot.pixels).toBeDefined();
    expect(snapshot.maskedRegionCount).toBe(0);
  });
});
