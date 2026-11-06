/**
 * Adapted from microsoft/playwright tests/page/page-request-fallback.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: a navigation's response is the one `browser.waitForResponse` sees.
 */

/*
 * Not ported:
 * - should chain once: needs `route(..., { times })`.
 * - should amend HTTP headers: needs `route.fallback({ headers })`.
 * - should delete header with undefined value: needs `route.fallback({ headers })`.
 * - should amend method: needs `route.fallback({ method })` and `page.waitForRequest`.
 * - should override request url: needs `route.fallback({ url })`.
 * - post data / should amend post data: needs `route.fallback({ postData })`.
 * - post data / should amend binary post data: needs `route.fallback({ postData })` and `request.postDataBuffer()`.
 * - post data / should amend json post data: needs `route.fallback({ postData })` and `request.postDataJSON()`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

test.describe('page request fallback', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.route('**/*', (route) => route.fallback());
    await browser.goto(EMPTY_PAGE);
  });

  test('should fall back', async ({ browser }) => {
    const intercepted: number[] = [];
    for (const index of [1, 2, 3]) {
      await browser.route('**/empty.html', async (route) => {
        intercepted.push(index);
        await route.fallback();
      });
    }
    await browser.goto(EMPTY_PAGE);
    expect(intercepted).toEqual([3, 2, 1]);
  });

  test('should fall back async', async ({ browser }) => {
    const intercepted: number[] = [];
    for (const index of [1, 2, 3]) {
      await browser.route('**/empty.html', async (route) => {
        intercepted.push(index);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await route.fallback();
      });
    }
    await browser.goto(EMPTY_PAGE);
    expect(intercepted).toEqual([3, 2, 1]);
  });

  test('should not chain fulfill', async ({ browser }) => {
    let failed = false;
    await browser.route('**/empty.html', async (route) => {
      failed = true;
      await route.continue();
    });
    await browser.route('**/empty.html', (route) => route.fulfill({ status: 200, body: 'fulfilled' }));
    await browser.route('**/empty.html', (route) => route.fallback());
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(EMPTY_PAGE)]);
    expect(await response.text()).toEqual('fulfilled');
    expect(failed).toBeFalsy();
  });

  test('should not chain abort', async ({ browser }) => {
    let failed = false;
    await browser.route('**/empty.html', async (route) => {
      failed = true;
      await route.continue();
    });
    await browser.route('**/empty.html', (route) => route.abort());
    await browser.route('**/empty.html', (route) => route.fallback());
    const e = await browser.goto(EMPTY_PAGE).catch((caught: Error) => caught);
    expect(e).toBeTruthy();
    expect(failed).toBeFalsy();
  });

  test('should fall back after exception', async ({ browser }) => {
    await browser.route('**/empty.html', (route) => route.continue());
    await browser.route('**/empty.html', async (route) => {
      try {
        await route.fulfill({ response: {} } as never);
      } catch {
        await route.fallback();
      }
    });
    await browser.goto(EMPTY_PAGE);
  });
});
