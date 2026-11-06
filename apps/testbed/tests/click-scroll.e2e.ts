/**
 * Adapted from microsoft/playwright tests/page/page-click-scroll.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.click(selector)` is a locator
 * tap, a `text=` selector a substring `getByText`.
 *
 * Not ported:
 * - should not crash when force-clicking hidden input: e2e tap has no force option.
 * - should not scroll the page when scroll is "none": e2e tap has no scroll option.
 * - should click in-viewport element when scroll is "none": same.
 * - should not scroll nested container when scroll is "none": same.
 * - should not scroll on hover when scroll is "none": same, and a `>>` chain.
 * - should scroll into view display:contents with position: Playwright skips it on Chromium.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, CROSS } from './helpers.ts';

test.describe('page click scroll', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should not hit scroll bar', async ({ screen, browser }) => {
    await browser.goto(content(`
      <style>
        .categories { width: 180px; display: flex; overflow-x: scroll; }
        button { flex: none; height: 28px; }
      </style>
      <div class="categories">
        <button>One</button>
        <button>Two</button>
        <button>Three</button>
        <button>Story</button>
        <button>More</button>
        <button>Items</button>
        <button>Here</button>
      </div>
    `));
    await screen.getByText('Story', { exact: false }).tap({ timeout: 2000 });
  });

  test('should scroll into view display:contents', async ({ screen, browser }) => {
    await browser.goto(content(`
      <div style="background:red;height:2000px">filler</div>
      <div>
        Example text, and button here:
        <button style="display: contents" onclick="window._clicked=true;">click me</button>
      </div>
    `));
    await screen.getByText('click me', { exact: false }).tap({ timeout: 5000 });
    expect(await browser.evaluate('window._clicked')).toBe(true);
  });

  test('should scroll into view display:contents with a child', async ({ screen, browser }) => {
    await browser.goto(content(`
      <div style="background:red;height:2000px">filler</div>
      Example text, and button here:
      <button style="display: contents" onclick="window._clicked=true;"><div>click me</div></button>
    `));
    await screen.getByText('click me', { exact: false }).tap({ timeout: 5000 });
    expect(await browser.evaluate('window._clicked')).toBe(true);
  });

  test('should scroll into view span element', async ({ browser }) => {
    await browser.goto(content(`
      <div id=big style="height: 10000px;"></div>
      <span id=small>foo</span>
    `));
    await browser.locator('#small').scrollIntoView();
    expect(await browser.evaluate<number>('() => window.scrollY')).toBeGreaterThan(9000);
  });

  test('should scroll into view element in iframe', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content(`
      <div id=big style="height: 10000px;"></div>
      <iframe src='${CROSS}/input/button.html'></iframe>
    `));
    await browser.frameLocator('iframe').getByRole('button').tap({ timeout: 5000 });
  });

  test('should scroll instantly on retry when scroll-behavior is smooth', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        html { scroll-behavior: smooth; }
        body { margin: 0; }
        .spacer { height: 2000px; }
        #header { position: fixed; top: 0; left: 0; right: 0; bottom: 50px; background: rgba(0, 0, 0, 0.1); }
        button { height: 30px; }
      </style>
      <div id="header"></div>
      <div class="spacer"></div>
      <button onclick="window.clicked = true">Target</button>
      <div class="spacer"></div>
      <script>
        window.scrolls = [];
        addEventListener('scroll', () => window.scrolls.push(window.scrollY));
      </script>
    `));
    await browser.locator('button').tap();
    expect(await browser.evaluate('window.clicked')).toBe(true);
    const scrolls = await browser.evaluate<number[]>("() => window['scrolls']");
    expect(scrolls.length).toBeLessThanOrEqual(2);
  });
});
