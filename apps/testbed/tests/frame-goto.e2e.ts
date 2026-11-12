/**
 * Adapted from microsoft/playwright tests/page/frame-goto.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: the stalled `/frames/script.js` is a route that sends
 * the request to a path the server never answers.
 */

/*
 * Not ported:
 * - should navigate subframes: frame.goto and Frame objects.
 * - should reject when frame detaches: frame.goto and Frame objects.
 * - should return matching responses: frame.goto, Frame objects, and per-request server responses.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PREFIX } from './helpers.ts';

test.describe('frame goto', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should continue after client redirect', async ({ browser }) => {
    await browser.route('**/frames/script.js', (route) => route.continue({ url: `${PREFIX}/never` }));
    const url = `${PREFIX}/frames/child-redirect.html`;
    const error = await browser.goto(url, { timeout: 5000, waitUntil: 'networkidle' }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('timed out in browser.goto');
  });
});
