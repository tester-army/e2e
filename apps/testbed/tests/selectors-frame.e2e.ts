/**
 * Adapted from microsoft/playwright tests/page/selectors-frame.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `iframe >> internal:control=enter-frame >> x` is
 * `frameLocator('iframe').locator(x)`, `:has-text()` a `hasText` filter, and the routed frame
 * pages are pages the server serves (`content()`).
 */

/*
 * Not ported:
 * - should work for iframe (handle): element handles.
 * - should work for nested iframe (handle): element handles.
 * - should work for $ and $$ (handle): element handles.
 * - should work for $eval (handle): element handles.
 * - should work for $$eval (handle): element handles.
 * - waitForSelector should survive frame reattach (handle): element handles.
 * - waitForSelector should survive iframe navigation (handle): element handles.
 * - $eval should throw for missing frame: asserts Playwright's `$eval` error text; e2e has no `$eval`.
 * - should not allow dangling enter-frame: Playwright selector syntax, which e2e locators do not take.
 * - should not allow leading enter-frame: Playwright selector syntax.
 * - should not allow capturing before enter-frame: Playwright selector syntax.
 * - should capture after the enter-frame: Playwright selector syntax (`*css=`) and innerHTML.
 * - should non work for non-frame: asserts Playwright's error text naming the matched `<div>`.
 * - should match in a descendant frame: `internal:control=any-frame` has no e2e counterpart.
 * - should match in a deeply nested frame: `internal:control=any-frame`.
 * - should not match a chain across frames: `internal:control=any-frame`.
 * - should match multiple elements: `internal:control=any-frame`.
 * - should throw when matching elements in multiple frames: `internal:control=any-frame` and page.frames().
 * - should not allow any-frame in the middle of a selector: `internal:control=any-frame`.
 * - should allow entering frames from any frame: `internal:control=any-frame`.
 * - should not allow any-frame after entering a frame: `internal:control=any-frame`.
 * - should not allow dangling enter-frame after any-frame: `internal:control=any-frame`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

const iframe2 = content('<html><button tag="iframe2">Hello nested iframe</button></html>');

const iframe = content(`
  <html>
    <div>
      <button>Hello iframe</button>
      <iframe src="${iframe2}"></iframe>
    </div>
    <span>1</span>
    <span>2</span>
  </html>`);

const routed = content(`<iframe src="${iframe}"></iframe>`);

/** Waits `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('selectors frame', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work for iframe', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button');
    await button.waitFor();
    expect(await button.textContent()).toBe('Hello iframe');
    await expect(button).toHaveText('Hello iframe');
    await button.tap();
  });

  test('should work for nested iframe', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').frameLocator('iframe').locator('button');
    await button.waitFor();
    expect(await button.textContent()).toBe('Hello nested iframe');
    await expect(button).toHaveText('Hello nested iframe');
    await button.tap();
  });

  test('should work for $ and $$', async ({ browser }) => {
    await browser.goto(routed);
    const element = browser.frameLocator('iframe').locator('button');
    await element.waitFor({ state: 'attached' });
    expect(await element.textContent()).toBe('Hello iframe');
    await browser.frameLocator('iframe').locator('span').nth(1).waitFor({ state: 'attached' });
    expect(await browser.frameLocator('iframe').locator('span').count()).toBe(2);
  });

  test('$ should not wait for frame', async ({ browser }) => {
    await browser.goto('/empty.html');
    expect(await browser.frameLocator('iframe').locator('canvas').count()).toBe(0);
  });

  test('$$ should not wait for frame', async ({ browser }) => {
    await browser.goto('/empty.html');
    expect(await browser.frameLocator('iframe').locator('canvas').all()).toHaveLength(0);
  });

  test('$$eval should not throw for missing frame', async ({ browser }) => {
    await browser.goto('/empty.html');
    expect(await browser.frameLocator('iframe').locator('canvas').allTextContents()).toHaveLength(0);
  });

  test('should work for $eval', async ({ browser }) => {
    await browser.goto(routed);
    await expect(browser.frameLocator('iframe').getByRole('button')).toHaveCount(1);
    await expect(browser.frameLocator('iframe').locator('button')).toHaveCount(1);
  });

  test('should work for $$eval', async ({ browser }) => {
    await browser.goto(routed);
    await expect(browser.frameLocator('iframe').locator('span')).toHaveCount(2);
    expect(await browser.frameLocator('iframe').locator('span').allTextContents()).toEqual(['1', '2']);
  });

  test('should click in lazy iframe', async ({ browser }) => {
    const lazy = content('<html><button>Hello iframe</button></html>');
    await browser.goto('/empty.html');
    const attached = delay(500)
      .then(() => browser.evaluate("() => { document.body.appendChild(document.createElement('iframe')); }"))
      .then(() => delay(500))
      .then(() => browser.evaluate("(src) => { document.querySelector('iframe').src = src; }", lazy));
    const button = browser.frameLocator('iframe').locator('button');
    const [, text] = await Promise.all([
      button.tap(),
      button.textContent(),
      expect(button).toHaveText('Hello iframe'),
      attached,
    ]);
    expect(text).toBe('Hello iframe');
  });

  test('waitFor should survive frame reattach', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button').filter({ hasText: 'Hello nested iframe' });
    const promise = button.waitFor();
    await browser.evaluate("() => { document.querySelector('iframe').remove(); }");
    await browser.evaluate("(src) => { const iframe = document.createElement('iframe'); iframe.src = src; document.body.appendChild(iframe); }", iframe2);
    await promise;
  });

  test('click should survive frame reattach', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button').filter({ hasText: 'Hello nested iframe' });
    const promise = button.tap();
    await browser.evaluate("() => { document.querySelector('iframe').remove(); }");
    await browser.evaluate("(src) => { const iframe = document.createElement('iframe'); iframe.src = src; document.body.appendChild(iframe); }", iframe2);
    await promise;
  });

  test('click should survive iframe navigation', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button').filter({ hasText: 'Hello nested iframe' });
    const promise = button.tap();
    const navigated = browser.evaluate("(src) => { document.querySelector('iframe').src = src; }", iframe2);
    await promise;
    await navigated;
  });

  test('click should survive navigation', async ({ browser }) => {
    await browser.goto(iframe);
    const promise = browser.locator('button').filter({ hasText: 'Hello nested iframe' }).tap();
    await delay(100);
    await browser.goto(iframe2);
    await promise;
  });
});
