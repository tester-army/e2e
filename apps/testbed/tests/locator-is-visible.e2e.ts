/**
 * Adapted from microsoft/playwright tests/page/locator-is-visible.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: the `page.isVisible(selector)` twins
 * of each locator read are locator reads, `locator(css, { hasText })` a
 * locator `filter({ hasText })`.
 *
 * Not ported:
 * - isVisible with invalid selector should throw: Playwright selector engine names.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

test.describe('locator is visible', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('isVisible and isHidden should work', async ({ browser }) => {
    await browser.goto(content(`<div>Hi</div><span></span>`));

    const div = browser.locator('div');
    expect(await div.isVisible()).toBe(true);
    expect(await div.isHidden()).toBe(false);

    const span = browser.locator('span');
    expect(await span.isVisible()).toBe(false);
    expect(await span.isHidden()).toBe(true);

    expect(await browser.locator('no-such-element').isVisible()).toBe(false);
    expect(await browser.locator('no-such-element').isHidden()).toBe(true);
  });

  test('isVisible should be true for opacity:0', async ({ browser }) => {
    await browser.goto(content(`<div style="opacity:0">Hi</div>`));
    await expect(browser.locator('div')).toBeVisible();
  });

  test('isVisible should be true for element outside view', async ({ browser }) => {
    await browser.goto(content(`<div style="position: absolute; left: -1000px">Hi</div>`));
    await expect(browser.locator('div')).toBeVisible();
  });

  test('isVisible and isHidden should work with details', async ({ browser }) => {
    await browser.goto(content(`<details>
      <summary>click to open</summary>
        <ul>
          <li>hidden item 1</li>
          <li>hidden item 2</li>
          <li>hidden item 3</li>
        </ul
    </details>`));

    await expect(browser.locator('ul')).toBeHidden();
  });

  test('isVisible and isHidden should work with nested details', async ({ screen, browser }) => {
    await browser.goto(content(`<details>
      <summary>outer</summary>
      <details open>
        <summary>inner</summary>
        <button>hidden button</button>
      </details>
    </details>`));

    await expect(browser.locator('summary').filter({ hasText: 'outer' })).toBeVisible();
    await expect(browser.locator('summary').filter({ hasText: 'inner' })).toBeHidden();
    await expect(browser.locator('button')).toBeHidden();
    await expect(screen.getByRole('button')).toHaveCount(0);
  });

  test('isVisible and isHidden should work with unslotted content', async ({ browser }) => {
    await browser.goto(content(`
      <div id=unslotted><span>hidden 1</span><div><span>hidden 2</span></div></div>
      <div id=slotted><span>visible</span></div>
      <script>
        unslotted.attachShadow({ mode: 'open' }).innerHTML = 'nothing to see here';
        slotted.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
      </script>
    `));

    await expect(browser.locator('span').filter({ hasText: 'hidden 1' })).toBeHidden();
    await expect(browser.locator('span').filter({ hasText: 'hidden 2' })).toBeHidden();
    await expect(browser.locator('span').filter({ hasText: 'visible' })).toBeVisible();
  });

  test('isVisible and isHidden should work with list box options', async ({ screen, browser }) => {
    await browser.goto(content(`
      <select multiple>
        <option>visible 1</option>
        <optgroup label="group"><option>visible 2</option></optgroup>
        <option hidden>hidden 1</option>
        <optgroup label="hidden group" style="display:none"><option>hidden 2</option></optgroup>
      </select>
      <select size=3><option>visible 3</option></select>
      <select multiple style="display:none"><option>hidden 3</option></select>
    `));

    for (const name of ['visible 1', 'visible 2', 'visible 3'])
      await expect(screen.getByRole('option', { name })).toBeVisible();
    for (const text of ['hidden 1', 'hidden 2', 'hidden 3'])
      await expect(browser.locator('option').filter({ hasText: text })).toBeHidden();
  });

  test('isVisible inside a button', async ({ browser }) => {
    await browser.goto(content(`<button><span></span>a button</button>`));
    const span = browser.locator('span');
    expect(await span.isVisible()).toBe(false);
    expect(await span.isHidden()).toBe(true);
    await expect(span).not.toBeVisible();
    await expect(span).toBeHidden();
    await span.waitFor({ state: 'hidden' });
    await browser.locator('button').waitFor({ state: 'visible' });
  });

  test('isVisible inside a role=button', async ({ browser }) => {
    await browser.goto(content(`<div role=button><span></span>a button</div>`));
    const span = browser.locator('span');
    expect(await span.isVisible()).toBe(false);
    expect(await span.isHidden()).toBe(true);
    await expect(span).not.toBeVisible();
    await expect(span).toBeHidden();
    await span.waitFor({ state: 'hidden' });
    await browser.locator('[role=button]').waitFor({ state: 'visible' });
  });

  test('isVisible during navigation should not throw', async ({ browser }) => {
    for (let i = 0; i < 20; i++) {
      await browser.goto(content(`
        <script>
          setTimeout(() => {
            window.location.href = '/empty.html';
          }, Math.random(50));
        </script>
      `)).catch(() => {});
      expect(await browser.locator('div').isVisible()).toBe(false);
    }
  });
});
