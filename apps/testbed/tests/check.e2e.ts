/**
 * Adapted from microsoft/playwright tests/page/page-check.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.check(selector)` is a locator check.
 */

/*
 * Not ported:
 * - should check the label with position: `check` takes no `position`.
 * - trial run should not check: no `trial` option.
 * - trial run should not uncheck: no `trial` option.
 * - should check the box using setChecked: no `setChecked`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

test.describe('page check', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should check the box', async ({ browser }) => {
    await browser.goto(content("<input id='checkbox' type='checkbox'></input>"));
    await browser.locator('input').check();
    expect(await browser.evaluate('() => window.checkbox.checked')).toBe(true);
  });

  test('should not check the checked box', async ({ browser }) => {
    await browser.goto(content("<input id='checkbox' type='checkbox' checked></input>"));
    await browser.locator('input').check();
    expect(await browser.evaluate('() => window.checkbox.checked')).toBe(true);
  });

  test('should uncheck the box', async ({ browser }) => {
    await browser.goto(content("<input id='checkbox' type='checkbox' checked></input>"));
    await browser.locator('input').uncheck();
    expect(await browser.evaluate('() => window.checkbox.checked')).toBe(false);
  });

  test('should not uncheck the unchecked box', async ({ browser }) => {
    await browser.goto(content("<input id='checkbox' type='checkbox'></input>"));
    await browser.locator('input').uncheck();
    expect(await browser.evaluate('() => window.checkbox.checked')).toBe(false);
  });

  test('should check radio', async ({ browser }) => {
    await browser.goto(content(`
      <input type='radio'>one</input>
      <input id='two' type='radio'>two</input>
      <input type='radio'>three</input>`));
    await browser.locator('#two').check();
    expect(await browser.evaluate('() => window.two.checked')).toBe(true);
  });

  test('should check radio by aria role', async ({ browser }) => {
    await browser.goto(content(`<div role='radio' id='checkbox'>CHECKBOX</div>
      <script>
        checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));
      </script>`));
    await browser.locator('div').check();
    expect(await browser.evaluate("() => window.checkbox.getAttribute('aria-checked')")).toBe('true');
  });

  test('should uncheck radio by aria role', async ({ browser }) => {
    await browser.goto(content(`<div role='radio' id='checkbox' aria-checked="true">CHECKBOX</div>
      <script>
        checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'false'));
      </script>`));
    await browser.locator('div').uncheck();
    expect(await browser.evaluate("() => window.checkbox.getAttribute('aria-checked')")).toBe('false');
  });

  test('should check the box by aria role', async ({ browser }) => {
    for (const role of ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem']) {
      await browser.goto(content(`<div role='${role}' id='checkbox'>CHECKBOX</div>
        <script>
          checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));
        </script>`));
      await browser.locator('div').check();
      expect(await browser.evaluate("() => window.checkbox.getAttribute('aria-checked')")).toBe('true');
    }
  });

  test('should uncheck the box by aria role', async ({ browser }) => {
    for (const role of ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem']) {
      await browser.goto(content(`<div role='${role}' id='checkbox' aria-checked="true">CHECKBOX</div>
        <script>
          checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'false'));
        </script>`));
      await browser.locator('div').uncheck();
      expect(await browser.evaluate("() => window.checkbox.getAttribute('aria-checked')")).toBe('false');
    }
  });

  test('should throw when not a checkbox', async ({ browser }) => {
    await browser.goto(content('<div>Check me</div>'));
    const error = await browser.locator('div').check().catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Not a checkbox or radio button');
  });

  test('should throw when not a checkbox 2', async ({ browser }) => {
    await browser.goto(content('<div role=button>Check me</div>'));
    const error = await browser.locator('div').check().catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Not a checkbox or radio button');
  });

  test('should check the box inside a button', async ({ browser }) => {
    await browser.goto(content("<div role='button'><input type='checkbox'></div>"));
    await browser.locator('input').check();
    expect(await browser.evaluate("() => document.querySelector('input').checked")).toBe(true);
    expect(await browser.locator('input').isChecked()).toBe(true);
  });

  test('should throw when trying to uncheck radio button', async ({ browser }) => {
    await browser.goto(content("<input type='radio' name='test' checked id='radio'>"));
    const error = await browser.locator('#radio').uncheck().catch((caught: Error) => caught);
    expect((error as Error).message).toContain('uncheck cannot clear a radio button');
  });
});
