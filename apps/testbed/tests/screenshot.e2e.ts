/**
 * Adapted from microsoft/playwright tests/page/page-screenshot.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.screenshot()` is `app.screenshot()`, read back with
 * pngjs, and a `mask` is the `toHaveScreenshot` option, compared against the same viewport with
 * boxes of the mask color painted over the masked elements. Playwright's golden images belong to
 * its own renderer setup, so a golden comparison becomes a check of the pixels it shows.
 */

/*
 * Not ported:
 * - should capture blinking caret if explicitly asked for: e2e has no `caret` option; its screenshots always hide the caret.
 * - should clip rect: e2e has no `clip` option.
 * - should clip rect with fullPage: e2e has no `clip` or `fullPage` option.
 * - should clip elements to the viewport: e2e has no `clip` option.
 * - should throw on clip outside the viewport: e2e has no `clip` option.
 * - should throw on a negative clip size: e2e has no `clip` option.
 * - should run in parallel: e2e has no `clip` option.
 * - should take fullPage screenshots: e2e has no `fullPage` option.
 * - should take fullPage screenshots and mask elements outside of it: e2e has no `fullPage` option.
 * - should restore viewport after fullPage screenshot: e2e has no `fullPage` option.
 * - should allow transparency: e2e has no `omitBackground` option.
 * - should render white background on jpeg file: e2e screenshots are PNG only.
 * - should produce a valid webp screenshot: e2e screenshots are PNG only.
 * - path option should detect webp: e2e has no `path` or `type` option.
 * - quality option should work for webp: e2e has no `quality` option.
 * - webp screenshots should be lossless by default: e2e screenshots are PNG only.
 * - should allow transparency with webp: e2e has no `omitBackground` option.
 * - quality option should throw for webp when out of range: e2e has no `quality` option.
 * - should work with odd clip size on Retina displays: e2e has no `clip` option or device scale factor.
 * - should work for webgl: golden only, and headless WebGL renders differently per GPU backend.
 * - path option should work: e2e has no `path` option.
 * - path option should create subdirectories: e2e has no `path` option.
 * - path option should detect jpeg: e2e has no `path` option.
 * - path option should throw for unsupported mime type: e2e has no `path` option.
 * - quality option should throw for png: e2e has no `quality` option.
 * - zero quality option should throw for png: e2e has no `quality` option.
 * - quality option should work for jpeg: e2e has no `quality` option.
 * - should prefer type over extension: e2e has no `path` or `type` option.
 * - should take fullPage screenshots during navigation: e2e has no `fullPage` option.
 * - mask option should work with elementhandle: element handles.
 * - mask option should hide elements based on attr: e2e has no `style` option.
 * - mask option should remove elements based on attr: e2e has no `style` option.
 * - page screenshot animations (all 13 tests): e2e has no `animations` option.
 * - should throw if screenshot size is too large: e2e has no `fullPage` option.
 * - page screenshot should capture css transform: golden only, of a 3D transform with no stable pixel to check.
 * The `fullPage` option of should work while navigating and should work with Array deleted is dropped: they take the viewport.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, type Browser, type WebApp } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PNG } from 'pngjs';
import { content, CROSS, PREFIX } from './helpers.ts';

const stored = new Set<string>();

/** One element a mask covers: a selector and its match index, inside the iframe `frame` matches when set. */
interface MaskTarget {
  readonly frame?: string;
  readonly selector: string;
  readonly index: number;
}

/** The PNG at `file`, decoded. */
function readPng(file: string): PNG {
  return PNG.sync.read(readFileSync(file));
}

/** The red, green, and blue of the pixel at (`x`, `y`). */
function rgb(png: PNG, x: number, y: number): [number, number, number] {
  const offset = (y * png.width + x) * 4;
  return [png.data[offset]!, png.data[offset + 1]!, png.data[offset + 2]!];
}

/** Whether two colors are the same within `slack` per channel. */
function near(actual: readonly number[], expected: readonly number[], slack = 3): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= slack);
}

/** The pixels of `box` cut out of `png`, rounded out to whole pixels. */
function crop(png: PNG, box: { x: number; y: number; width: number; height: number }): Buffer {
  const left = Math.floor(box.x);
  const top = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width);
  const bottom = Math.ceil(box.y + box.height);
  const rows: Buffer[] = [];
  for (let y = top; y < bottom; y++) rows.push(png.data.subarray((y * png.width + left) * 4, (y * png.width + right) * 4));
  return Buffer.concat(rows);
}

/** Where `toHaveScreenshot(name)` in this file reads its stored screenshot on the `web` target. */
function storedPath(name: string): string {
  return path.join(import.meta.dirname, 'screenshot.e2e.ts-snapshots', `${name}-web-${process.platform}.png`);
}

/**
 * Paints a `color` box over each of `targets`, as a `mask` would cover it, keeps the viewport as
 * the stored screenshot `name`, then takes the boxes away.
 */
async function storeMaskedReference(browser: Browser, app: WebApp, name: string, targets: readonly MaskTarget[], color = '#ff00ff'): Promise<void> {
  await browser.evaluate(`({ targets, color }) => {
    for (const { frame, selector, index } of targets) {
      const host = frame === undefined ? undefined : document.querySelector(frame);
      const origin = host === undefined ? { left: 0, top: 0 } : host.getBoundingClientRect();
      const offset = host === undefined ? { left: 0, top: 0 } : { left: host.clientLeft, top: host.clientTop };
      const element = (host === undefined ? document : host.contentDocument).querySelectorAll(selector)[index];
      const rect = element.getBoundingClientRect();
      const box = document.createElement('div');
      box.setAttribute('data-test-mask', '');
      box.style.cssText = 'position: fixed; z-index: 2147483647; pointer-events: none; margin: 0; border: 0; padding: 0;';
      box.style.left = (origin.left + offset.left + rect.left) + 'px';
      box.style.top = (origin.top + offset.top + rect.top) + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      box.style.background = color;
      document.documentElement.appendChild(box);
    }
  }`, { targets: targets.map((target) => ({ ...target })), color });
  await storeReference(app, name);
  await browser.evaluate("() => { for (const box of document.querySelectorAll('[data-test-mask]')) box.remove(); }");
}

/** Keeps the viewport, as `app.screenshot` takes it, as the stored screenshot `name` until the test ends. */
async function storeReference(app: WebApp, name: string): Promise<void> {
  const file = storedPath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  stored.add(file);
  copyFileSync(await app.screenshot(name), file);
}

/** Appends an iframe with `id` loading `url`, Playwright's `attachFrame`, once it has loaded. */
async function attachFrame(browser: Browser, id: string, url: string): Promise<void> {
  await browser.evaluate(`async ({ id, url }) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.id = id;
    document.body.appendChild(frame);
    await new Promise((x) => (frame.onload = x));
  }`, { id, url });
}

/** Adds a `<style>` with `css` to the page, Playwright's `addStyleTag({ content })`. */
async function addStyleTag(browser: Browser, css: string): Promise<void> {
  await browser.evaluate("(css) => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); }", css);
}

test.afterEach(() => {
  for (const file of stored) rmSync(file, { force: true });
  stored.clear();
});

test.describe('page screenshot', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const screenshot = readPng(await app.screenshot());
    expect([screenshot.width, screenshot.height]).toEqual([500, 500]);
    expect(rgb(screenshot, 0, 0)).toEqual([169, 169, 169]);
    expect(near(rgb(screenshot, 3, 3), [255, 204, 204])).toBe(true);
    expect(near(rgb(screenshot, 453, 453), [255, 204, 207])).toBe(true);
  });

  test('should not capture blinking caret by default', async ({ app, browser }) => {
    await browser.goto(content(`
      <link rel=stylesheet href="${CROSS}/injectedstyle.css">
      <style>
        div {
          caret-color: #000 !important;
        }
      </style>
      <div contenteditable="true"></div>
    `));
    const div = browser.locator('div');
    await div.pressSequentially('foo bar');
    const box = (await div.boundingBox())!;
    const screenshot = crop(readPng(await app.screenshot()), box);
    for (let i = 0; i < 10; ++i) {
      await new Promise((x) => setTimeout(x, 150));
      const newScreenshot = crop(readPng(await app.screenshot()), box);
      expect(newScreenshot.equals(screenshot)).toBe(true);
    }
  });

  test('should capture blinking caret in shadow dom', async ({ app, browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate(`() => {
      class CustomElementContainer extends HTMLElement {
        #shadowRoot;
        constructor() {
          super();
          this.#shadowRoot = this.attachShadow({ mode: 'open' });
          this.#shadowRoot.innerHTML = '<custom-element-input-wrapper><input type="text"/></custom-element-input-wrapper>';
        }
      }
      class CustomElementInputWrapper extends HTMLElement {
        #shadowRoot;
        constructor() {
          super();
          this.#shadowRoot = this.attachShadow({ mode: 'open' });
          this.#shadowRoot.innerHTML = '<style>:host { all: initial; }</style><slot/>';
        }
      }
      customElements.define('custom-element-input-wrapper', CustomElementInputWrapper);
      customElements.define('custom-element-container', CustomElementContainer);

      const container = document.createElement('custom-element-container');
      document.body.appendChild(container);
    }`);

    const input = browser.locator('input');
    await input.focus();

    const box = (await input.boundingBox())!;
    const screenshot = crop(readPng(await app.screenshot()), box);
    let hasDifferentScreenshots = false;
    for (let i = 0; !hasDifferentScreenshots && i < 10; ++i) {
      await new Promise((x) => setTimeout(x, 150));
      const newScreenshot = crop(readPng(await app.screenshot()), box);
      hasDifferentScreenshots = !newScreenshot.equals(screenshot);
    }
    expect(hasDifferentScreenshots).toBe(false);
  });

  test('should work for canvas', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/screenshots/canvas.html');
    const screenshot = readPng(await app.screenshot());
    expect(rgb(screenshot, 8 + 30, 8 + 30)).toEqual([0, 0, 0]);
    expect(rgb(screenshot, 8 + 120, 8 + 120)).toEqual([0, 0, 0]);
    expect(rgb(screenshot, 8 + 60, 8 + 60)).toEqual([255, 255, 255]);
    expect(rgb(screenshot, 8 + 75, 8 + 75)).toEqual([255, 255, 255]);
    expect(rgb(screenshot, 8 + 140, 8 + 140)).toEqual([255, 255, 255]);
  });

  test('should capture canvas changes', async ({ app, browser }) => {
    await browser.goto(content('<canvas></canvas>'));
    await browser.evaluate(`() => {
      const canvas = document.querySelector('canvas');
      canvas.width = 600;
      canvas.height = 600;
    }`);

    /** Draws the horizontal line of `step`, 100 pixels below the one before. */
    async function addLine(step: number): Promise<void> {
      await browser.evaluate(`(n) => {
        const canvas = document.querySelector('canvas');
        const ctx = canvas.getContext('2d');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, n * 100);
        ctx.lineTo(300, n * 100);
        ctx.stroke();
      }`, step);
    }

    /** Whether the line of `step` shows in `screenshot`: the canvas sits at the body margin, 8 pixels in. */
    function hasLine(screenshot: PNG, step: number): boolean {
      const y = 8 + step * 100;
      return [y - 1, y].some((row) => row >= 8 && rgb(screenshot, 8 + 150, row)[0] < 200);
    }

    for (let i = 0; i < 3; i++) {
      await addLine(i);
      await new Promise((f) => setTimeout(f, 100));
      const screenshot = readPng(await app.screenshot());
      for (let step = 0; step < 3; step++) expect(hasLine(screenshot, step)).toBe(step <= i);
    }
  });

  test('should work for translateZ', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/screenshots/translateZ.html');
    const screenshot = readPng(await app.screenshot());
    expect(rgb(screenshot, 120, 120)).toEqual([255, 0, 0]);
    expect(rgb(screenshot, 175, 175)).toEqual([0, 128, 0]);
    expect(rgb(screenshot, 230, 230)).toEqual([0, 128, 0]);
    expect(rgb(screenshot, 300, 300)).toEqual([255, 255, 255]);
  });

  test('should work while navigating', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/redirectloop1.html');
    for (let i = 0; i < 10; i++) {
      const screenshot = readPng(await app.screenshot());
      expect([screenshot.width, screenshot.height]).toEqual([500, 500]);
    }
  });

  test('should work with iframe in shadow', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid-iframe-in-shadow.html');
    await expect(browser.frameLocator('iframe').locator('div').first()).toBeVisible();
    const screenshot = readPng(await app.screenshot());
    expect(near(rgb(screenshot, 3, 3), [255, 204, 204])).toBe(true);
    expect(rgb(screenshot, 400, 400)).toEqual([255, 255, 255]);
  });

  test('should not issue resize event', async ({ app, browser }) => {
    await browser.goto('/grid.html');
    await browser.evaluate("() => { window.__resized = false; window.addEventListener('resize', () => { window.__resized = true; }); }");
    await app.screenshot();
    expect(await browser.evaluate('window.__resized')).toBe(false);
  });

  test('should work with Array deleted', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    await browser.evaluate('() => { delete window.Array; }');
    const screenshot = readPng(await app.screenshot());
    expect([screenshot.width, screenshot.height]).toEqual([500, 500]);
    expect(near(rgb(screenshot, 3, 3), [255, 204, 204])).toBe(true);
  });

  test.describe('mask option', () => {
    test('should work', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'mask-should-work', [{ selector: 'div', index: 5 }]);
      await expect(screen).toHaveScreenshot('mask-should-work', {
        mask: [browser.locator('div').nth(5)],
      });
    });

    test('should work with locator', async ({ app, browser }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'mask-should-work-with-locator', [{ selector: 'div', index: 5 }]);
      const bodyLocator = browser.locator('body');
      await expect(bodyLocator).toHaveScreenshot('mask-should-work-with-locator', {
        mask: [browser.locator('div').nth(5)],
      });
    });

    test('should mask multiple elements', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'should-mask-multiple-elements', [{ selector: 'div', index: 5 }, { selector: 'div', index: 12 }]);
      await expect(screen).toHaveScreenshot('should-mask-multiple-elements', {
        mask: [
          browser.locator('div').nth(5),
          browser.locator('div').nth(12),
        ],
      });
    });

    test('should mask inside iframe', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await attachFrame(browser, 'frame1', `${PREFIX}/grid.html`);
      await addStyleTag(browser, 'iframe { border: none; }');
      await storeMaskedReference(browser, app, 'should-mask-inside-iframe', [{ selector: 'div', index: 5 }, { frame: '#frame1', selector: 'div', index: 12 }]);
      await expect(screen).toHaveScreenshot('should-mask-inside-iframe', {
        mask: [
          browser.locator('div').nth(5),
          browser.frameLocator('#frame1').locator('div').nth(12),
        ],
      });
    });

    test('should mask in parallel', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/empty.html');
      await attachFrame(browser, 'frame1', `${PREFIX}/grid.html`);
      await attachFrame(browser, 'frame2', `${PREFIX}/grid.html`);
      await addStyleTag(browser, 'iframe { border: none; }');
      await storeMaskedReference(browser, app, 'should-mask-in-parallel-1', [{ frame: '#frame1', selector: 'div', index: 1 }]);
      await storeMaskedReference(browser, app, 'should-mask-in-parallel-2', [{ frame: '#frame2', selector: 'div', index: 3 }]);
      const results = await Promise.allSettled([
        expect(screen).toHaveScreenshot('should-mask-in-parallel-1', {
          mask: [browser.frameLocator('#frame1').locator('div').nth(1)],
        }),
        expect(screen).toHaveScreenshot('should-mask-in-parallel-2', {
          mask: [browser.frameLocator('#frame2').locator('div').nth(3)],
        }),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });

    test('should remove mask after screenshot', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      const screenshot1 = readFileSync(await app.screenshot());
      await storeMaskedReference(browser, app, 'should-remove-mask-after-screenshot', [{ selector: 'div', index: 1 }]);
      await expect(screen).toHaveScreenshot('should-remove-mask-after-screenshot', {
        mask: [browser.locator('div').nth(1)],
      });
      const screenshot2 = readFileSync(await app.screenshot());
      expect(screenshot1.equals(screenshot2)).toBe(true);
    });

    test('should work when subframe has stalled navigation', async ({ app, browser, screen }) => {
      let routed!: () => void;
      const routeReady = new Promise<void>((f) => (routed = f));
      let release!: () => void;
      const released = new Promise<void>((f) => (release = f));
      await browser.route('**/subframe.html', async (route) => {
        routed();
        await released;
        await route.fulfill({ body: '' });
      });

      await browser.goto(content('<iframe></iframe>'));
      await storeReference(app, 'mask-stalled-subframe');
      await browser.goto(content(`<iframe src='/subframe.html'></iframe>`), { waitUntil: 'domcontentloaded' });
      await routeReady;

      await expect(screen).toHaveScreenshot('mask-stalled-subframe', { mask: [browser.locator('non-existent')] });
      release();
      await expect(browser.frameLocator('iframe').locator('body')).toBeAttached();
    });

    test('should work when subframe used document.open after a weird url', async ({ app, browser, screen }) => {
      await browser.goto('/empty.html');
      await browser.evaluate(`() => {
        const iframe = document.createElement('iframe');
        iframe.src = 'javascript:hi';
        document.body.appendChild(iframe);
        iframe.contentDocument.open();
        iframe.contentDocument.write('Hello');
        iframe.contentDocument.close();
      }`);
      await storeReference(app, 'mask-document-open');
      await expect(screen).toHaveScreenshot('mask-document-open', { mask: [browser.locator('non-existent')] });
    });

    test('should work when mask color is not pink #F0F', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'mask-color-should-work', [{ selector: 'div', index: 5 }], '#00ff00');
      await expect(screen).toHaveScreenshot('mask-color-should-work', {
        mask: [browser.locator('div').nth(5)],
        maskColor: '#00FF00',
      });
    });
  });
});

test('should capture css box-shadow', { requires: ['browser'], tags: ['playwright'] }, async ({ app, browser }) => {
  await browser.goto(content(`<div style="box-shadow: red 10px 10px 10px; width: 50px; height: 50px;"></div>`));
  const screenshot = readPng(await app.screenshot());
  expect(rgb(screenshot, 30, 30)).toEqual([255, 255, 255]);
  expect(rgb(screenshot, 62, 40)[0]).toBe(255);
  expect(rgb(screenshot, 62, 40)[1]).toBeLessThan(200);
  expect(rgb(screenshot, 100, 100)).toEqual([255, 255, 255]);
});
