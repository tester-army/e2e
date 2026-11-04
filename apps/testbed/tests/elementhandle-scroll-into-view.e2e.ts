/**
 * Adapted from microsoft/playwright tests/page/elementhandle-scroll-into-view.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: an element handle's
 * `scrollIntoViewIfNeeded` is a locator `scrollIntoView`, its own `evaluate`
 * a page `evaluate` on the same element.
 *
 * Not ported:
 * - should throw for detached element: a handle to a removed element; a locator re-resolves.
 */

import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

/**
 * Starts scrolling the page's one `div` into view, checks it is still
 * waiting a second later, runs `after` on the div in the page, and checks the
 * scroll then finishes: Playwright's `testWaiting`.
 */
async function testWaiting(browser: Browser, after: string): Promise<void> {
  let done = false;
  const promise = browser.locator('div').scrollIntoView().then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(done).toBe(false);
  await browser.evaluate(`() => { const div = document.querySelector('div'); (${after})(div); }`);
  await promise;
  expect(done).toBe(true);
}

test.describe('elementhandle scroll into view', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work @smoke', async ({ browser }) => {
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

  test('should wait for display:none to become visible', async ({ browser }) => {
    await browser.goto(content('<div style="display:none">Hello</div>'));
    await testWaiting(browser, "div => div.style.display = 'block'");
  });

  test('should scroll display:contents into view', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
        ::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; }
      </style>
      <div id=container style="width:200px;height:200px;overflow:scroll;border:1px solid black;">
        <div style="margin-top:500px;background:red;">
          <div style="height:50px;width:100px;background:cyan;">
            <div id=target style="display:contents">Hello</div>
          </div>
        <div>
      </div>
    `));
    await browser.locator('#target').scrollIntoView();
    const scrollTop = await browser.evaluate<number>("() => document.querySelector('#container').scrollTop");
    expect(Math.abs(scrollTop - 350)).toBeLessThan(1);
  });

  test('should work for visibility:hidden element', async ({ browser }) => {
    await browser.goto(content('<div style="visibility:hidden">Hello</div>'));
    await browser.locator('div').scrollIntoView();
  });

  test('should work for zero-sized element', async ({ browser }) => {
    await browser.goto(content('<div style="height:0">Hello</div>'));
    await browser.locator('div').scrollIntoView();
  });

  test('should wait for nested display:none to become visible', async ({ browser }) => {
    await browser.goto(content('<span style="display:none"><div>Hello</div></span>'));
    await testWaiting(browser, "div => div.parentElement.style.display = 'block'");
  });

  test('should wait for element to stop moving', async ({ browser }) => {
    await browser.goto(content(`
      <style>
        @keyframes move {
          from { margin-left: 0; }
          to { margin-left: 200px; }
        }
        div.animated {
          animation: 2s linear 0s infinite alternate move;
        }
      </style>
      <div class=animated>moving</div>
    `));
    await testWaiting(browser, "div => div.classList.remove('animated')");
  });

  test('should timeout waiting for visible', async ({ browser }) => {
    await browser.goto(content('<div style="display:none">Hello</div>'));
    const error = await browser.locator('div').scrollIntoView({ timeout: 3000 }).catch((e: unknown) => e);
    expect(error).toEqual(expect.any(Error));
  });
});
