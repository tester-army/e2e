/**
 * Adapted from microsoft/playwright tests/page/selectors-text.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `locator(css, { hasText })` is a
 * locator `filter({ hasText })`, `toHaveId(id)` an `id` attribute match.
 *
 * Not ported:
 * - should work @smoke: Playwright `text=` and quoted selector strings, `page.$eval`.
 * - should work with :text: Playwright `:text`, `:text-is`, `:text-matches` pseudo-classes.
 * - should support empty string: same, plus `>>` chains.
 * - should work across nodes: same, plus `text=`.
 * - should work with text nodes in quoted mode: `text=` selectors.
 * - should clear caches: element handles and `text=` selectors.
 * - should work with :has-text: Playwright `:has-text` pseudo-class.
 * - should work with large DOM: a timing run of Playwright selector engines.
 * - should be case sensitive if quotes are specified: `text=` selectors.
 * - should search for a substring without quotes: `text=` selectors.
 * - should skip head, script and style: element handles and `text=` selectors.
 * - should match input[type=button|submit|reset]: `text=` selectors.
 * - should work for open shadow roots: `text=`, `text:light=` and `>>` selectors.
 * - should prioritize light dom over shadow dom in the same parent: `>>` chain.
 * - should waitForSelector with distributed elements: `page.waitForSelector` with a `>>` chain.
 * - should match root after >>: `>>` chains.
 * - should match root after >> with *: `>>` chain with a capture.
 * - should work with leading and trailing spaces: `text=` selectors.
 * - should work with unpaired quotes when not at the start: `text=` and `>>` selectors.
 * - should work with paired quotes in the middle of selector: `>>` chains.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

test.describe('selectors text', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('text-is() should ignore comments', async ({ screen, browser }) => {
    await browser.goto(content(`<div id=me>hel<!-- comment -->lo
    <!-- comment -->
    world</div>`));
    expect(await browser.locator('div').filter({ hasText: 'hello world' }).getAttribute('id')).toBe('me');
    expect(await screen.getByText('hello world').getAttribute('id')).toBe('me');
  });

  test('hasText and internal:text should match full node text in strict mode', async ({ screen, browser }) => {
    await browser.goto(content(`
      <div id=div1>hello<span>world</span></div>
      <div id=div2>hello</div>
    `));
    await expect(screen.getByText('helloworld')).toHaveAttribute('id', 'div1');
    await expect(screen.getByText('hello')).toHaveAttribute('id', 'div2');
    await expect(browser.locator('div').filter({ hasText: /^helloworld$/ })).toHaveAttribute('id', 'div1');
    await expect(browser.locator('div').filter({ hasText: /^hello$/ })).toHaveAttribute('id', 'div2');

    await browser.goto(content(`
      <div id=div1><span id=span1>hello</span>world</div>
      <div id=div2><span id=span2>hello</span></div>
    `));
    await expect(screen.getByText('helloworld')).toHaveAttribute('id', 'div1');
    expect(await screen.getByText('hello').nth(0).getAttribute('id')).toBe('span1');
    expect(await screen.getByText('hello').nth(1).getAttribute('id')).toBe('span2');
    await expect(screen.getByText('hello')).toHaveCount(2);
    await expect(browser.locator('div').filter({ hasText: /^helloworld$/ })).toHaveAttribute('id', 'div1');
    await expect(browser.locator('div').filter({ hasText: /^hello$/ })).toHaveAttribute('id', 'div2');
  });
});
