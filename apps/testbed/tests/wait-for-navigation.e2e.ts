/**
 * Adapted from microsoft/playwright tests/page/page-wait-for-navigation.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.waitForNavigation()` is `browser.waitForURL` with the URL the
 * navigation lands on, and a `url` matcher is a RegExp.
 */

/*
 * Not ported:
 * - should work with both domcontentloaded and load: needs `waitForNavigation({ waitUntil })`.
 * - should work with commit: needs `waitForNavigation({ waitUntil: 'commit' })`.
 * - should work with clicking on links which do not commit navigation: needs an HTTPS server with a bad certificate.
 * - should work when subframe issues window.stop(): needs `frameattached` and `framenavigated` events.
 * - should work on frame: needs `frame.waitForNavigation`.
 * - should fail when frame detaches: needs `frame.waitForNavigation`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, CROSS, PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

test.describe('page wait for navigation', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await Promise.all([
      browser.waitForURL('/grid.html'),
      browser.evaluate('(url) => { window.location.href = url; }', `${PREFIX}/grid.html`),
    ]);
    expect(await browser.url()).toContain('grid.html');
  });

  test('should respect timeout', async ({ browser }) => {
    // e2e opens no page before the first goto, where Playwright starts on about:blank.
    await browser.goto('/one-style.html');
    const promise = browser.waitForURL('/frame.html', { timeout: 5000 });
    await browser.goto(EMPTY_PAGE);
    const error = await promise.catch((caught: Error) => caught);
    expect((error as Error).message).toContain('/frame.html');
    expect((error as Error).message).toContain(EMPTY_PAGE);
  });

  test('should work with clicking on anchor links', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const page = content("<a href='#foobar'>foobar</a>");
    await browser.goto(page);
    await Promise.all([
      browser.waitForURL(`${page}#foobar`),
      browser.locator('a').tap(),
    ]);
    expect(await browser.url()).toBe(`${PREFIX}${page}#foobar`);
  });

  test('should work with history.pushState()', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content(`
      <a onclick='javascript:pushState()'>SPA</a>
      <script>
        function pushState() { history.pushState({}, '', 'wow.html') }
      </script>
    `));
    await Promise.all([
      browser.waitForURL('/wow.html'),
      browser.locator('a').tap(),
    ]);
    expect(await browser.url()).toBe(`${PREFIX}/wow.html`);
  });

  test('should work with history.replaceState()', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content(`
      <a onclick='javascript:replaceState()'>SPA</a>
      <script>
        function replaceState() { history.replaceState({}, '', '/replaced.html') }
      </script>
    `));
    await Promise.all([
      browser.waitForURL('/replaced.html'),
      browser.locator('a').tap(),
    ]);
    expect(await browser.url()).toBe(`${PREFIX}/replaced.html`);
  });

  test('should work with DOM history.back()/history.forward()', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content(`
      <a id=back onclick='javascript:goBack()'>back</a>
      <a id=forward onclick='javascript:goForward()'>forward</a>
      <script>
        function goBack() { history.back(); }
        function goForward() { history.forward(); }
        history.pushState({}, '', '/first.html');
        history.pushState({}, '', '/second.html');
      </script>
    `));
    expect(await browser.url()).toBe(`${PREFIX}/second.html`);
    await Promise.all([
      browser.waitForURL('/first.html'),
      browser.locator('a#back').tap(),
    ]);
    expect(await browser.url()).toBe(`${PREFIX}/first.html`);
    await Promise.all([
      browser.waitForURL('/second.html'),
      browser.locator('a#forward').tap(),
    ]);
    expect(await browser.url()).toBe(`${PREFIX}/second.html`);
  });

  test('should work with url match', async ({ browser }) => {
    // e2e opens no page before the first goto, where Playwright starts on about:blank.
    await browser.goto(content('<p>blank</p>'));
    let response1 = false;
    const response1Promise = browser.waitForURL(/one-style\.html/).then(() => (response1 = true));
    let response2 = false;
    const response2Promise = browser.waitForURL(/\/frame.html/).then(() => (response2 = true));
    let response3 = false;
    const response3Promise = browser.waitForURL(/[?&]foo=bar/).then(() => (response3 = true));
    expect(response1).toBe(false);
    expect(response2).toBe(false);
    expect(response3).toBe(false);
    await browser.goto(EMPTY_PAGE);
    expect(response1).toBe(false);
    expect(response2).toBe(false);
    expect(response3).toBe(false);
    await browser.goto('/frame.html');
    expect(response1).toBe(false);
    await response2Promise;
    expect(response2).toBe(true);
    expect(response3).toBe(false);
    await browser.goto('/one-style.html');
    await response1Promise;
    expect(response1).toBe(true);
    expect(response2).toBe(true);
    expect(response3).toBe(false);
    await browser.goto('/frame.html?foo=bar');
    await response3Promise;
    expect(response1).toBe(true);
    expect(response2).toBe(true);
    expect(response3).toBe(true);
    await browser.goto('/empty.html');
  });

  test('should work with url match for same document navigations', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    let resolved = false;
    const waitPromise = browser.waitForURL(/third\.html/).then(() => (resolved = true));
    expect(resolved).toBe(false);
    await browser.evaluate("() => { history.pushState({}, '', '/first.html'); }");
    expect(resolved).toBe(false);
    await browser.evaluate("() => { history.pushState({}, '', '/second.html'); }");
    expect(resolved).toBe(false);
    await browser.evaluate("() => { history.pushState({}, '', '/third.html'); }");
    await waitPromise;
    expect(resolved).toBe(true);
  });

  test('should work for cross-process navigations', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const url = `${CROSS}/empty.html`;
    const waitPromise = browser.waitForURL(url);
    const gotoPromise = browser.goto(url, { waitUntil: 'domcontentloaded' });
    await waitPromise;
    expect(await browser.url()).toBe(url);
    expect(await browser.evaluate('document.location.href')).toBe(url);
    await gotoPromise;
  });
});
