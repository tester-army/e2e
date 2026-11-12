/**
 * Adapted from microsoft/playwright tests/page/locator-misc-2.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `scrollIntoViewIfNeeded` is
 * `scrollIntoView`, an element's own `evaluate` a page `evaluate`.
 *
 * Not ported:
 * - should select textarea: e2e has no selectText.
 * - should type: deprecated `locator.type`; its replacement, pressSequentially, is ported.
 * - should take screenshot: compares with Playwright's own golden image.
 * - should combine visible with other selectors: `>> visible=true` selector chains.
 * - should support filter(visible): e2e filter has no visible option.
 * - should support visible(): e2e locators have no visible().
 * - Locator.locator() and FrameLocator.locator() should accept locator: e2e locators have no locator(locator).
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

test.describe('locator misc 2', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should press @smoke', async ({ browser }) => {
    await browser.goto(content(`<input type='text' />`));
    await browser.locator('input').press('h');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('h');
  });

  test('should scroll into view', async ({ browser }) => {
    await browser.goto('/offscreenbuttons.html');
    const overflow = '(id) => document.getElementById(id).getBoundingClientRect().right - window.innerWidth';
    for (let i = 0; i < 11; ++i) {
      const before = await browser.evaluate<number, string>(overflow, `btn${i}`);
      expect(before).toBe(10 * i);
      await browser.locator(`#btn${i}`).scrollIntoView();
      const after = await browser.evaluate<number, string>(overflow, `btn${i}`);
      expect(after <= 0).toBe(true);
      await browser.evaluate('() => window.scrollTo(0, 0)');
    }
  });

  test('should scroll zero-sized element into view', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        html,body { margin: 0; padding: 0; }
        ::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; }
      </style>
      <div style="height: 2000px; text-align: center; border: 10px solid blue;">
        <h1>SCROLL DOWN</h1>
      </div>
      <div id=lazyload style="font-size:75px; background-color: green;"></div>
      <script>
        const lazyLoadElement = document.querySelector('#lazyload');
        const observer = new IntersectionObserver((entries) => {
          if (entries.some(entry => entry.isIntersecting)) {
            lazyLoadElement.textContent = 'LAZY LOADED CONTENT';
            lazyLoadElement.style.height = '20px';
            observer.disconnect();
          }
        });
        observer.observe(lazyLoadElement);
      </script>
    `));
    expect(await browser.locator('#lazyload').boundingBox()).toEqual({ x: 0, y: 2020, width: 1280, height: 0 });
    await browser.locator('#lazyload').scrollIntoView();
    await expect(browser.locator('#lazyload')).toHaveText('LAZY LOADED CONTENT');
    expect(await browser.locator('#lazyload').boundingBox()).toEqual({ x: 0, y: 720, width: 1280, height: 20 });
  });

  test('should pressSequentially', async ({ browser }) => {
    await browser.goto(content(`<input type='text' />`));
    await browser.locator('input').pressSequentially('hello');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('hello');
  });

  test('should return bounding box', async ({ browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const element = browser.locator('.box:nth-of-type(13)');
    const box = await element.boundingBox();
    expect(box).toEqual({ x: 100, y: 50, width: 50, height: 50 });
  });

  test('should waitFor', async ({ browser }) => {
    await browser.goto(content(`<div></div>`));
    const locator = browser.locator('span');
    const promise = locator.waitFor();
    await browser.evaluate("() => { document.querySelector('div').innerHTML = '<span>target</span>'; }");
    await promise;
    await expect(locator).toHaveText('target');
  });

  test('should waitFor hidden', async ({ browser }) => {
    await browser.goto(content(`<div><span>target</span></div>`));
    const locator = browser.locator('span');
    const promise = locator.waitFor({ state: 'hidden' });
    await browser.evaluate("() => { document.querySelector('div').innerHTML = ''; }");
    await promise;
  });

  test('locator.count should work with deleted Map in main world', { fail: 'locators resolve in Playwright\'s main world, which a page that replaces `Map` breaks; Playwright resolves its own in a utility world, but e2e\'s closed-shadow reach and locate reads need the main world' }, async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate('() => { window.Map = 1; }');
    await browser.locator('#searchResultTableDiv .x-grid3-row').count();
    await expect(browser.locator('#searchResultTableDiv .x-grid3-row')).toHaveCount(0);
  });

  test('should fill programmatically enabled textarea', async ({ browser }) => {
    await browser.goto(content(`
      <button>Enable</button>
      <form>
        <textarea id="text" disabled></textarea>
      </form>
      <script>
        document.querySelector('button').addEventListener('click', () => {
          document.querySelector('#text').disabled = false;
        });
      </script>
    `));
    await browser.locator('button').click();
    await browser.locator('#text').fill('Hello');
    await expect(browser.locator('#text')).toHaveValue('Hello');
  });

  test('press should throw on unknown keys', async ({ screen, browser }) => {
    await browser.goto(content(`<input type='text' value='hello' />`));
    const locator = screen.getByRole('textbox');
    for (const key of ['NotARealKey', 'ё', '😊']) {
      const error = await locator.press(key).catch((e: unknown) => e);
      expect(error).toEqual(expect.any(Error));
      expect((error as Error).message).toContain(key);
    }
  });
});
