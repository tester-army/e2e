/**
 * Adapted from microsoft/playwright tests/page/locator-convenience.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: the `page.<read>(selector)` twins of
 * each locator read are locator reads, a `:text("...")` selector is
 * `getByText`, and an element's own `evaluate` is a page `evaluate`.
 *
 * Not ported:
 * - should have a nice preview: locator string previews and `evaluateHandle`.
 * - innerHTML should work: e2e has no innerHTML.
 * - innerText should work: e2e has no innerText.
 * - innerText should throw: same.
 * - innerText should produce log: same.
 * - isEditable should work: e2e has no isEditable.
 * - allInnerTexts should work: e2e has no allInnerTexts.
 * - should return page: e2e locators have no page().
 * - description should return null for locator without description: e2e has no describe().
 * - description should return description for locator with simple description: same.
 * - description should return description with special characters: same.
 * - description should return description for chained locators: same.
 * - description should return description for locator with multiple describe calls: same.
 * - toString() returns formatted locator: e2e locators have no Playwright toString().
 * - toString() prefers description: same.
 * - textContent should work: `textContent()` reads rendered text with whitespace normalized on purpose, where Playwright keeps the raw text.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

test.describe('locator convenience', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('getAttribute should work', async ({ browser }) => {
    await browser.goto('/dom.html');
    const locator = browser.locator('#outer');
    expect(await locator.getAttribute('name')).toBe('value');
    expect(await locator.getAttribute('foo')).toBe(null);
  });

  test('inputValue should work', async ({ browser }) => {
    await browser.goto('/dom.html');

    await browser.locator('#select').selectOption({ value: 'foo' });
    expect(await browser.locator('#select').inputValue()).toBe('foo');

    await browser.locator('#textarea').fill('text value');
    expect(await browser.locator('#textarea').inputValue()).toBe('text value');

    await browser.locator('#input').fill('input value');
    expect(await browser.locator('#input').inputValue()).toBe('input value');

    const error = await browser.locator('#inner').inputValue().catch((e: unknown) => e);
    expect(error).toEqual(expect.any(Error));
  });

  test('isEnabled and isDisabled should work', async ({ screen, browser }) => {
    await browser.goto(content(`
      <button disabled>button1</button>
      <button>button2</button>
      <div>div</div>
    `));
    const div = browser.locator('div');
    expect(await div.isEnabled()).toBe(true);
    expect(await div.isDisabled()).toBe(false);
    const button1 = screen.getByText('button1', { exact: false });
    expect(await button1.isEnabled()).toBe(false);
    expect(await button1.isDisabled()).toBe(true);
    const button2 = screen.getByText('button2', { exact: false });
    expect(await button2.isEnabled()).toBe(true);
    expect(await button2.isDisabled()).toBe(false);
  });

  test('isChecked should work', async ({ browser }) => {
    await browser.goto(content(`<input type='checkbox' checked><div>Not a checkbox</div>`));
    const element = browser.locator('input');
    expect(await element.isChecked()).toBe(true);
    await browser.evaluate("() => { document.querySelector('input').checked = false; }");
    expect(await element.isChecked()).toBe(false);
    const error = await browser.locator('div').isChecked().catch((e: unknown) => e);
    expect(error).toEqual(expect.any(Error));
  });

  test('isChecked should work for indeterminate input', async ({ browser }) => {
    await browser.goto(content(`<input type="checkbox" checked>`));
    await browser.evaluate("() => { document.querySelector('input').indeterminate = true; }");

    expect(await browser.locator('input').isChecked()).toBe(true);
    await expect(browser.locator('input')).toBeChecked();

    await browser.locator('input').uncheck();

    expect(await browser.locator('input').isChecked()).toBe(false);
    await expect(browser.locator('input')).not.toBeChecked();
  });

  test('allTextContents should work', async ({ browser }) => {
    await browser.goto(content(`<div>A</div><div>B</div><div>C</div>`));
    expect(await browser.locator('div').allTextContents()).toEqual(['A', 'B', 'C']);
  });
});
