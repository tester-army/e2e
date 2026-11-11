/**
 * Adapted from microsoft/playwright tests/page/page-wait-for-response.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `browser.waitForResponse` takes a URL pattern.
 */

/*
 * Not ported:
 * - should respect timeout: needs `page.waitForEvent('response')`.
 * - should respect default timeout: needs `page.setDefaultTimeout` and a predicate.
 * - should work with predicate: needs `page.waitForEvent('response', predicate)`.
 * - should work with async predicate: needs response predicates.
 * - sync predicate should be only called once: needs response predicates.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

test.describe('page wait for response', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [response] = await Promise.all([
      browser.waitForResponse(`${PREFIX}/digits/2.png`),
      browser.evaluate(`() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }`),
    ]);
    expect(response.url).toBe(`${PREFIX}/digits/2.png`);
  });

  test('should log the url', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const error1 = await browser.waitForResponse('foo.css', { timeout: 1000 }).catch((caught: Error) => caught);
    expect((error1 as Error).message).toContain('"foo.css"');
    const error2 = await browser.waitForResponse(/foo.css/i, { timeout: 1000 }).catch((caught: Error) => caught);
    expect((error2 as Error).message).toContain('/foo.css/i');
  });

  test('should work with no timeout', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [response] = await Promise.all([
      browser.waitForResponse(`${PREFIX}/digits/2.png`, { timeout: 0 }),
      browser.evaluate(`() => setTimeout(() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }, 50) && null`),
    ]);
    expect(response.url).toBe(`${PREFIX}/digits/2.png`);
  });
});
