/**
 * Adapted from microsoft/playwright tests/page/page-select-option.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.selectOption(selector, value)` is a locator selectOption.
 */

/*
 * Not ported:
 * - should select single option by handle: no element handles.
 * - should select single option by multiple attributes: `selectOption` takes one of label, value, or index.
 * - should not select single option when some attributes do not match: `selectOption` takes one of label, value, or index.
 * - should select only first option: `selectOption` takes one option, no arrays.
 * - should select multiple options: `selectOption` takes one option, no arrays.
 * - should select multiple options with attributes: `selectOption` takes one option, no arrays.
 * - should return [] on no matched values: `selectOption` returns nothing and takes no arrays.
 * - should return an array of matched values: `selectOption` returns nothing and takes no arrays.
 * - should return an array of one element when multiple is not set: `selectOption` returns nothing and takes no arrays.
 * - should return [] on no values: `selectOption` returns nothing and takes no arrays.
 * - should not allow null items: no arrays or null.
 * - should unselect with null: no arrays or null.
 * - should deselect all options when passed no values for a multiple select: no arrays.
 * - should deselect all options when passed no values for a select without multiple: no arrays.
 * - should throw if passed wrong types: asserts Playwright's protocol validator messages; the option is typed.
 * - should wait for multiple options to be present: `selectOption` takes one option, no arrays.
 * - should select single option: a bare string selects by label only on purpose, where Playwright matches the value or the label.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

/** Five pairs of animation frames, Playwright's `rafraf(page, 5)`, so a pending select has had its chance. */
const giveItAChanceToResolve = '() => new Promise((resolve) => { let frames = 0; const step = () => (++frames === 10 ? setTimeout(resolve, 0) : requestAnimationFrame(step)); requestAnimationFrame(step); })';

/** Appends a `scarlet` option to the page's select. */
const addScarlet = "() => { const option = document.createElement('option'); option.value = 'scarlet'; option.textContent = 'Scarlet'; document.querySelector('select').appendChild(option); }";

test.describe('page select option', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should select single option by value', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.locator('select').selectOption({ value: 'blue' });
    expect(await browser.evaluate('() => window.result.onInput')).toEqual(['blue']);
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['blue']);
  });

  test('should fall back to selecting by label', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.locator('select').selectOption('Blue');
    expect(await browser.evaluate('() => window.result.onInput')).toEqual(['blue']);
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['blue']);
  });

  test('should select single option by label', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.locator('select').selectOption({ label: 'Indigo' });
    expect(await browser.evaluate('() => window.result.onInput')).toEqual(['indigo']);
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['indigo']);
  });

  test('should select single option by label with html whitespace', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.locator('select').selectOption({ label: 'HTML' });
    expect(await browser.evaluate('() => window.result.onInput')).toEqual(['html']);
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['html']);
  });

  test('should select single option by index', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.locator('select').selectOption({ index: 2 });
    expect(await browser.evaluate('() => window.result.onInput')).toEqual(['brown']);
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['brown']);
  });

  test('should not throw when select causes navigation', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.evaluate("() => document.querySelector('select').addEventListener('input', () => window.location.href = '/empty.html')");
    await Promise.all([
      browser.locator('select').selectOption({ value: 'blue' }),
      browser.waitForURL(/empty\.html/),
    ]);
    expect(await browser.url()).toContain('empty.html');
  });

  test('should respect event bubbling', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.locator('select').selectOption({ value: 'blue' });
    expect(await browser.evaluate('() => window.result.onBubblingInput')).toEqual(['blue']);
    expect(await browser.evaluate('() => window.result.onBubblingChange')).toEqual(['blue']);
  });

  test('should throw when element is not a <select>', async ({ browser }) => {
    await browser.goto('/input/select.html');
    const error = await browser.locator('body').selectOption('').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Element is not a <select> element');
  });

  test('should work when re-defining top-level Event class', async ({ browser }) => {
    await browser.goto('/input/select.html');
    await browser.evaluate('() => { window.Event = null; }');
    await browser.locator('select').selectOption({ value: 'blue' });
    expect(await browser.evaluate('() => window.result.onInput')).toEqual(['blue']);
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['blue']);
  });

  test('should wait for option to be present', async ({ browser }) => {
    await browser.goto('/input/select.html');
    const selectPromise = browser.locator('select').selectOption({ value: 'scarlet' }, { timeout: 10_000 });
    let didSelect = false;
    void selectPromise.then(() => (didSelect = true));
    await browser.evaluate(giveItAChanceToResolve);
    expect(didSelect).toBe(false);
    await browser.evaluate(addScarlet);
    await selectPromise;
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['scarlet']);
  });

  test('should wait for option index to be present', async ({ browser }) => {
    await browser.goto('/input/select.html');
    const len = await browser.evaluate<number>("() => document.querySelector('select').options.length");
    const selectPromise = browser.locator('select').selectOption({ index: len }, { timeout: 10_000 });
    let didSelect = false;
    void selectPromise.then(() => (didSelect = true));
    await browser.evaluate(giveItAChanceToResolve);
    expect(didSelect).toBe(false);
    await browser.evaluate(addScarlet);
    await selectPromise;
    expect(await browser.evaluate('() => window.result.onChange')).toEqual(['scarlet']);
  });

  test('input event.composed should be true and cross shadow dom boundary', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content(`<body><script>
    const div = document.createElement('div');
    const shadowRoot = div.attachShadow({mode: 'open'});
    shadowRoot.innerHTML = \`<select>
      <option value="black">Black</option>
      <option value="blue">Blue</option>
    </select>\`;
    document.body.appendChild(div);
  </script></body>`));
    await browser.evaluate(`() => {
      window.firedBodyEvents = [];
      for (const event of ['input', 'change'])
        document.body.addEventListener(event, (e) => window.firedBodyEvents.push(e.type + ':' + e.composed), false);
    }`);
    await browser.evaluate(`() => {
      window.firedEvents = [];
      const select = document.querySelector('div').shadowRoot.querySelector('select');
      for (const event of ['input', 'change'])
        select.addEventListener(event, (e) => window.firedEvents.push(e.type + ':' + e.composed), false);
    }`);
    await browser.locator('select').selectOption({ value: 'blue' });
    expect(await browser.evaluate('firedEvents')).toEqual(['input:true', 'change:false']);
    expect(await browser.evaluate('firedBodyEvents')).toEqual(['input:true']);
  });

  test('should wait for select to be enabled', async ({ browser }) => {
    await browser.goto(content(`
      <select disabled>
        <option>one</option>
        <option>two</option>
      </select>

      <script>
      function hydrate() {
        const select = document.querySelector('select');
        select.removeAttribute('disabled');
        select.addEventListener('change', () => {
          window['result'] = select.value;
        });
      }
      </script>
    `));
    const selectPromise = browser.locator('select').selectOption('two');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await browser.evaluate('() => window.hydrate()');
    await selectPromise;
    expect(await browser.evaluate('result')).toEqual('two');
    await expect(browser.locator('select')).toHaveValue('two');
  });

  test('should wait for option to be enabled', async ({ browser }) => {
    await browser.goto(content(`
      <select>
        <option>one</option>
        <option disabled id=myoption>two</option>
      </select>

      <script>
      function hydrate() {
        const option = document.querySelector('#myoption');
        option.removeAttribute('disabled');
        const select = document.querySelector('select');
        select.addEventListener('change', () => {
          window['result'] = select.value;
        });
      }
      </script>
    `));
    const error = await browser.locator('select').selectOption('two', { timeout: 1000 }).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('option being selected is not enabled');

    const selectPromise = browser.locator('select').selectOption('two');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await browser.evaluate('() => window.hydrate()');
    await selectPromise;
    expect(await browser.evaluate('result')).toEqual('two');
    await expect(browser.locator('select')).toHaveValue('two');
  });

  test('should wait for optgroup to be enabled', async ({ browser }) => {
    await browser.goto(content(`
      <select>
        <option>one</option>
        <optgroup label="Group" disabled id=mygroup>
          <option>two</option>
        </optgroup>
      </select>

      <script>
      function hydrate() {
        const group = document.querySelector('#mygroup');
        group.removeAttribute('disabled');
        const select = document.querySelector('select');
        select.addEventListener('change', () => {
          window['result'] = select.value;
        });
      }
      </script>
    `));
    const error = await browser.locator('select').selectOption('two', { timeout: 1000 }).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('option being selected is not enabled');

    const selectPromise = browser.locator('select').selectOption('two');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await browser.evaluate('() => window.hydrate()');
    await selectPromise;
    expect(await browser.evaluate('result')).toEqual('two');
    await expect(browser.locator('select')).toHaveValue('two');
  });

  test('should wait for select to be swapped', async ({ browser }) => {
    await browser.goto(content(`
      <select disabled>
        <option>one</option>
        <option>two</option>
      </select>

      <script>
      function hydrate() {
        const select = document.querySelector('select');
        select.remove();

        const newSelect = document.createElement('select');
        const option1 = document.createElement('option');
        option1.textContent = 'one';
        newSelect.appendChild(option1);
        const option2 = document.createElement('option');
        option2.textContent = 'two';
        newSelect.appendChild(option2);

        document.body.appendChild(newSelect);

        newSelect.addEventListener('change', () => {
          window['result'] = newSelect.value;
        });
      }
      </script>
    `));
    const selectPromise = browser.locator('select').selectOption('two');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await browser.evaluate('() => window.hydrate()');
    await selectPromise;
    await expect(browser.locator('select')).toHaveValue('two');
    expect(await browser.evaluate('result')).toEqual('two');
  });
});
