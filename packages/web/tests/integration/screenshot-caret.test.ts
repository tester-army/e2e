/** A screenshot must not edit the form elements a server-rendered app hydrates. */

import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { BrowserConnection } from '../../src/browser-connection.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
import { capturePixels } from '../../src/observe.ts';
import { adoptCaretStylesheet, CARET_STYLESHEET, removeCaretStylesheet } from '../../src/screenshot-caret.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

const connection = new BrowserConnection();
let app: FixtureApp;
let context: BrowserContext;

beforeAll(async () => {
  app = await startFixtureApp();
  const browser: Browser = await connection.acquire('chromium', false, 30_000);
  context = await browser.newContext({ viewport: { width: 320, height: 200 } });
  await context.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
});

afterAll(async () => {
  await context?.close();
  await connection.dispose();
  await app?.close();
});

const operation: OperationContext = {
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  runId: 'run',
  attemptId: 'attempt',
  origin: 'agent',
};

it('captures masked pixels without touching inline styles in the light DOM or a closed root', async () => {
  const page = await context.newPage();
  try {
    await page.goto(`${app.url}/caret`);
    await page.evaluate(() => {
      const watch = (target: Node, into: string[]) => {
        new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'attributes' && record.attributeName === 'style') {
              into.push((record.target as HTMLElement).id);
            }
          }
        }).observe(target, { subtree: true, attributes: true, attributeFilter: ['style'] });
      };
      const light: string[] = [];
      const shadow: string[] = [];
      (window as unknown as { lightMutations: string[] }).lightMutations = light;
      (window as unknown as { shadowMutations: string[] }).shadowMutations = shadow;
      watch(document.documentElement, light);
      const tracker = (globalThis as unknown as Record<symbol, WeakMap<Element, ShadowRoot> | undefined>)[
        Symbol.for('e2e.closedShadowRoots')
      ];
      const root = tracker?.get(document.getElementById('caret-host')!);
      if (root === undefined) throw new Error('the fixture closed root was not recorded');
      watch(root, shadow);
    });

    const capture = await capturePixels(page, operation, { width: 320, height: 200 });

    expect(capture.pixels.width).toBe(320);
    expect(capture.maskedRegionCount).toBeGreaterThan(0);
    expect(capture.maskingProven).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { lightMutations: string[] }).lightMutations)).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { shadowMutations: string[] }).shadowMutations)).toEqual([]);
  } finally {
    await page.close();
  }
});

it('hides a closed root caret the root styles itself, and restores it after removal', async () => {
  const page = await context.newPage();
  try {
    await page.goto(`${app.url}/caret`);
    const caretColor = () =>
      page.evaluate(() => {
        const tracker = (globalThis as unknown as Record<symbol, WeakMap<Element, ShadowRoot> | undefined>)[
          Symbol.for('e2e.closedShadowRoots')
        ];
        const root = tracker?.get(document.getElementById('caret-host')!);
        const input = root?.getElementById('shadowed');
        if (input === null || input === undefined) throw new Error('the fixture closed input is missing');
        return getComputedStyle(input).caretColor;
      });

    expect(await caretColor()).toBe('rgb(255, 0, 0)');
    const covered = await page.evaluate(adoptCaretStylesheet, { source: CARET_STYLESHEET, token: 'probe' });
    expect(covered).toBeGreaterThanOrEqual(2);
    expect(await caretColor()).toBe('rgba(0, 0, 0, 0)');
    await page.evaluate(removeCaretStylesheet, 'probe');
    expect(await caretColor()).toBe('rgb(255, 0, 0)');
  } finally {
    await page.close();
  }
});

it('hides the caret on a page whose style-src policy blocks style elements', async () => {
  const page = await context.newPage();
  try {
    await page.goto(`${app.url}/caret-csp`);
    const caretColor = () =>
      page.evaluate(() => getComputedStyle(document.getElementById('plain')!).caretColor);

    expect(
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = 'input { caret-color: transparent !important; }';
        document.head.append(style);
        return getComputedStyle(document.getElementById('plain')!).caretColor;
      }),
    ).toBe('rgb(0, 0, 0)');

    const covered = await page.evaluate(adoptCaretStylesheet, { source: CARET_STYLESHEET, token: 'csp' });
    expect(covered).toBe(1);
    expect(await caretColor()).toBe('rgba(0, 0, 0, 0)');
    await page.evaluate(removeCaretStylesheet, 'csp');
    expect(await caretColor()).toBe('rgb(0, 0, 0)');
  } finally {
    await page.close();
  }
});
