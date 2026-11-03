/**
 * Adapted from microsoft/playwright tests/page/locator-list.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../parity/LICENSE).
 * Rewritten against the e2e public API: `div >> p` is the CSS `div p`.
 */

import { expect } from 'e2e';
import { content, test } from './helpers.ts';

test.describe('locator list', { requires: ['browser'] }, () => {
  test('locator.all should work', async ({ browser }) => {
    await browser.goto(content(`<div><p>A</p><p>B</p><p>C</p></div>`));
    const texts = [];
    for (const p of await browser.locator('div p').all())
      texts.push(await p.textContent());
    expect(texts).toEqual(['A', 'B', 'C']);
  });
});
