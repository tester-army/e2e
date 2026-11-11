/**
 * A frame whose first request is held shows its initial empty document. An
 * observation reads and screenshots the page around it without waiting for
 * that navigation to commit.
 */

import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { BrowserConnection } from '../../src/browser-connection.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
import { captureObservation } from '../../src/observation-capture.ts';
import { capturePixels } from '../../src/observe.ts';
import { RefRegistry } from '../../src/refs.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

const connection = new BrowserConnection();
let app: FixtureApp;
let context: BrowserContext;
let opened: Page | undefined;
const held: Route[] = [];

const operation: OperationContext = {
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  runId: 'run',
  attemptId: 'attempt',
  origin: 'agent',
};

beforeAll(async () => {
  app = await startFixtureApp();
  const browser: Browser = await connection.acquire('chromium', false, 30_000);
  context = await browser.newContext({ viewport: { width: 320, height: 200 } });
  await context.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
});

afterEach(async () => {
  await opened?.close();
  await Promise.all(held.splice(0).map((route) => route.abort().catch(() => undefined)));
});

afterAll(async () => {
  await context?.close();
  await connection.dispose();
  await app?.close();
});

/** Opens a page holding an iframe whose request for `/held.html` never gets an answer. */
async function pageWithHeldFrame(attributes = ''): Promise<Page> {
  const page = await context.newPage();
  opened = page;
  let routed!: () => void;
  const routeReady = new Promise<void>((resolve) => (routed = resolve));
  await page.route('**/held.html', (route) => {
    held.push(route);
    routed();
  });
  await page.goto(app.url);
  await page.evaluate((extra) => {
    document.body.insertAdjacentHTML('beforeend', `<iframe ${extra} src="/held.html"></iframe>`);
  }, attributes);
  await routeReady;
  expect(page.frames().map((frame) => frame.url())).toEqual([`${app.url}/`, '']);
  return page;
}

describe('a frame whose navigation is held', () => {
  it('leaves the observation whole and its pixels proven masked', async () => {
    const page = await pageWithHeldFrame();

    const { snapshot } = await captureObservation(page, new RefRegistry(), { testIdAttribute: 'data-testid', site: app.url }, operation, { pixels: true });

    expect(snapshot.pixels?.width).toBe(320);
    expect(snapshot.truncated).toBeUndefined();
    expect(snapshot.maskedRegionCount).toBe(0);
    const pixels = await capturePixels(page, operation, { width: 320, height: 200 });
    expect(pixels.maskingProven).toBe(true);
  });

  it('masks a secure field the parent wrote into the initial document', async () => {
    const page = await pageWithHeldFrame();
    await page.evaluate(() => {
      document.querySelector('iframe')!.contentDocument!.body.innerHTML = '<input type="password" value="hunter2">';
    });

    const pixels = await capturePixels(page, operation, { width: 320, height: 200 });

    expect(pixels.maskedRegionCount).toBe(1);
    expect(pixels.maskingProven).toBe(true);
  });

  it('captures past a sandboxed frame no script can reach', async () => {
    const page = await pageWithHeldFrame('sandbox');

    const pixels = await capturePixels(page, operation, { width: 320, height: 200 });

    expect(pixels.maskedRegionCount).toBe(0);
    expect(pixels.maskingProven).toBe(true);
  });
});
