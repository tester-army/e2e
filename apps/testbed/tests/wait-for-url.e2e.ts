/**
 * Adapted from microsoft/playwright tests/page/page-wait-for-url.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `waitForURL` takes a URL or a RegExp, so a glob is the URL it names.
 */

/*
 * Not ported:
 * - should work with both domcontentloaded and load: needs `waitForURL({ waitUntil })`.
 * - should work with commit: needs `waitForURL({ waitUntil })`.
 * - should work with commit and about:blank: needs `waitForURL({ waitUntil })`.
 * - should work on frame: needs `frame.waitForURL`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

test.describe('page wait for url', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.evaluate('(url) => { window.location.href = url; }', `${PREFIX}/grid.html`);
    await browser.waitForURL('/grid.html');
  });

  test('should respect timeout', async ({ browser }) => {
    // e2e opens no page before the first goto, where Playwright starts on about:blank.
    await browser.goto(EMPTY_PAGE);
    const promise = browser.waitForURL('/frame.html', { timeout: 2500 }).catch((caught: Error) => caught);
    await browser.goto(EMPTY_PAGE);
    const error = await promise;
    expect((error as Error).message).toContain('frame.html');
  });

  test('should work with clicking on anchor links', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content("<a href='#foobar'>foobar</a>"));
    await browser.locator('a').tap();
    await browser.waitForURL(/#foobar$/);
  });

  test('should work with history.pushState()', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content(`
      <a onclick='javascript:pushState()'>SPA</a>
      <script>
        function pushState() { history.pushState({}, '', 'wow.html') }
      </script>
    `));
    await browser.locator('a').tap();
    await browser.waitForURL('/wow.html');
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
    await browser.locator('a').tap();
    await browser.waitForURL('/replaced.html');
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

    await browser.locator('a#back').tap();
    await browser.waitForURL('/first.html');
    expect(await browser.url()).toBe(`${PREFIX}/first.html`);

    await browser.locator('a#forward').tap();
    await browser.waitForURL('/second.html');
    expect(await browser.url()).toBe(`${PREFIX}/second.html`);
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
});
