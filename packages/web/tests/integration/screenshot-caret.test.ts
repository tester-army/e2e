/** A screenshot must not edit the form elements a server-rendered app hydrates. */

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { BrowserConnection } from '../../src/browser-connection.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
import { capturePixels } from '../../src/observe.ts';
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

interface Sample {
  /** The caret color of every editable, light DOM, closed root, and iframe. */
  readonly colors: Record<string, string>;
  /** The constructed stylesheets the main document, the closed root, and the iframe document hold. */
  readonly adopted: [number, number, number];
}

/** Samples the page's editable caret colors and how many sheets each root still holds. */
async function sample(page: Page): Promise<Sample> {
  const colors = await page.evaluate(() => {
    const read: Record<string, string> = {};
    for (const id of ['plain', 'notes', 'secret']) {
      const element = document.getElementById(id);
      if (element !== null) read[id] = getComputedStyle(element).caretColor;
    }
    const tracker = (globalThis as unknown as Record<symbol, WeakMap<Element, ShadowRoot> | undefined>)[
      Symbol.for('e2e.closedShadowRoots')
    ];
    const shadowed = tracker?.get(document.getElementById('caret-host')!)?.getElementById('shadowed');
    if (shadowed !== null && shadowed !== undefined) read.shadowed = getComputedStyle(shadowed).caretColor;
    return read;
  });
  const adopted = await page.evaluate(() => {
    const tracker = (globalThis as unknown as Record<symbol, WeakMap<Element, ShadowRoot> | undefined>)[
      Symbol.for('e2e.closedShadowRoots')
    ];
    const closed = tracker?.get(document.getElementById('caret-host')!);
    if (closed === undefined) throw new Error('the fixture closed root was not recorded');
    return [document.adoptedStyleSheets.length, closed.adoptedStyleSheets.length] as [number, number];
  });
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (frame === undefined) throw new Error('the fixture iframe is missing');
  colors.framed = await frame.evaluate(() => getComputedStyle(document.getElementById('framed')!).caretColor);
  const framedAdopted = await frame.evaluate(() => document.adoptedStyleSheets.length);
  return { colors, adopted: [adopted[0], adopted[1], framedAdopted] };
}

/** Makes `page.screenshot` run `record` at the moment the capture is taken. */
function recordDuringCapture(page: Page, record: (one: Sample) => Promise<void>): void {
  const raw = page.screenshot.bind(page);
  vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
    await record(await sample(page));
    return raw(options);
  });
}

it('hides every caret while the capture runs and restores each root afterwards', async () => {
  const page = await context.newPage();
  try {
    await page.goto(`${app.url}/caret`);
    // The main document and the iframe document each watch their own `style`
    // writes, so a hidden write in either one fails the test.
    const watchStyleWrites = () => {
      const into: string[] = [];
      (window as unknown as { styleMutations: string[] }).styleMutations = into;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes' && record.attributeName === 'style') {
            into.push((record.target as HTMLElement).id);
          }
        }
      }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'] });
    };
    await page.evaluate(watchStyleWrites);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error('the fixture iframe is missing');
    await frame.evaluate(watchStyleWrites);
    const before = await sample(page);
    expect(before.colors).toEqual({
      plain: 'rgb(0, 0, 0)',
      notes: 'rgb(0, 0, 0)',
      secret: 'rgb(0, 0, 0)',
      shadowed: 'rgb(255, 0, 0)',
      framed: 'rgb(0, 0, 0)',
    });
    expect(before.adopted).toEqual([0, 0, 0]);
    const during: Sample[] = [];
    recordDuringCapture(page, async (one) => {
      during.push(one);
    });

    const capture = await capturePixels(page, operation, { width: 320, height: 200 });

    expect(capture.pixels.width).toBe(320);
    expect(capture.maskedRegionCount).toBeGreaterThan(0);
    expect(capture.maskingProven).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { styleMutations: string[] }).styleMutations)).toEqual([]);
    expect(await frame.evaluate(() => (window as unknown as { styleMutations: string[] }).styleMutations)).toEqual([]);
    expect(during).toHaveLength(1);
    expect(during[0]!.colors).toEqual({
      plain: 'rgba(0, 0, 0, 0)',
      notes: 'rgba(0, 0, 0, 0)',
      secret: 'rgba(0, 0, 0, 0)',
      shadowed: 'rgba(0, 0, 0, 0)',
      framed: 'rgba(0, 0, 0, 0)',
    });
    expect(during[0]!.adopted).toEqual([1, 1, 1]);
    expect(await sample(page)).toEqual(before);
  } finally {
    await page.close();
  }
});

it('restores every root when the screenshot fails', async () => {
  const page = await context.newPage();
  try {
    await page.goto(`${app.url}/caret`);
    const before = await sample(page);
    vi.spyOn(page, 'screenshot').mockImplementation(async () => {
      throw new Error('capture failed');
    });

    await expect(capturePixels(page, operation, { width: 320, height: 200 })).rejects.toThrow('capture failed');

    expect(await sample(page)).toEqual(before);
  } finally {
    await page.close();
  }
});

it('hides the caret on a page whose style-src policy blocks style elements', async () => {
  const page = await context.newPage();
  try {
    await page.goto(`${app.url}/caret-csp`);
    const caretColor = () => page.evaluate(() => getComputedStyle(document.getElementById('plain')!).caretColor);
    // The policy is real: a style element does not apply.
    expect(
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = 'input { caret-color: transparent !important; }';
        document.head.append(style);
        return getComputedStyle(document.getElementById('plain')!).caretColor;
      }),
    ).toBe('rgb(0, 0, 0)');
    const during: string[] = [];
    const raw = page.screenshot.bind(page);
    vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
      during.push(await caretColor());
      return raw(options);
    });

    await capturePixels(page, operation, { width: 320, height: 200 });

    expect(during).toEqual(['rgba(0, 0, 0, 0)']);
    expect(await caretColor()).toBe('rgb(0, 0, 0)');
    expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);
  } finally {
    await page.close();
  }
});
