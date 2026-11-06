/**
 * Adapted from microsoft/playwright tests/page/selectors-role.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: a `role=` selector is `getByRole`
 * with the same options, a string name is exact by default so Playwright's
 * default substring match is `{ exact: false }`, and an
 * `evaluateAll(e => e.outerHTML)` read is the matches' texts or attributes.
 * The `include-hidden`, `checked="mixed"`, and `pressed="mixed"` cases are
 * left out: e2e getByRole has no includeHidden or mixed state.
 *
 * Not ported:
 * - errors: Playwright `role=` selector parse errors.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Locator } from 'e2e';
import { content } from './helpers.ts';

/** The `aria-label` of every current match, in document order. */
async function labels(locator: Locator): Promise<(string | null)[]> {
  return Promise.all((await locator.all()).map((match) => match.getAttribute('aria-label')));
}

test.describe('selectors role', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should detect roles', async ({ screen, browser }) => {
    await browser.goto(content(`
      <button>Hello</button>
      <select multiple="" size="2"></select>
      <select></select>
      <h3>Heading</h3>
      <details><summary>Hello</summary></details>
      <div role="dialog">I am a dialog</div>
    `));
    expect(await screen.getByRole('button').allTextContents()).toEqual(['Hello']);
    await expect(screen.getByRole('listbox')).toHaveCount(1);
    await expect(screen.getByRole('listbox')).toHaveAttribute('multiple', '');
    await expect(screen.getByRole('combobox')).toHaveCount(1);
    expect(await screen.getByRole('combobox').getAttribute('multiple')).toBe(null);
    expect(await screen.getByRole('heading').allTextContents()).toEqual(['Heading']);
    expect(await screen.getByRole('group').allTextContents()).toEqual(['Hello']);
    expect(await screen.getByRole('dialog').allTextContents()).toEqual(['I am a dialog']);
    expect(await screen.getByRole('menuitem').allTextContents()).toEqual([]);
  });

  test('should support selected', async ({ screen, browser }) => {
    await browser.goto(content(`
      <select>
        <option>Hi</option>
        <option selected>Hello</option>
      </select>
      <div>
        <div role="option" aria-selected="true">Hi</div>
        <div role="option" aria-selected="false">Hello</div>
      </div>
    `));
    expect(await screen.getByRole('option', { selected: true }).allTextContents()).toEqual(['Hello', 'Hi']);
    expect(await screen.getByRole('option', { selected: false }).allTextContents()).toEqual(['Hi', 'Hello']);
  });

  test('should support checked', async ({ screen, browser }) => {
    await browser.goto(content(`
      <input type=checkbox>
      <input type=checkbox checked>
      <input type=checkbox indeterminate>
      <div role=checkbox aria-checked="true">Hi</div>
      <div role=checkbox aria-checked="false">Hello</div>
      <div role=checkbox>Unknown</div>
    `));
    await browser.evaluate("() => { document.querySelector('[indeterminate]').indeterminate = true; }");

    const checked = screen.getByRole('checkbox', { checked: true });
    await expect(checked).toHaveCount(2);
    await expect(checked.first()).toHaveAttribute('checked', '');
    await expect(checked.nth(1)).toHaveText('Hi');

    const unchecked = screen.getByRole('checkbox', { checked: false });
    await expect(unchecked).toHaveCount(3);
    expect(await unchecked.first().getAttribute('checked')).toBe(null);
    expect(await unchecked.first().getAttribute('indeterminate')).toBe(null);
    expect(await unchecked.allTextContents()).toEqual(['', 'Hello', 'Unknown']);

    await expect(screen.getByRole('checkbox')).toHaveCount(6);
  });

  test('should support pressed', async ({ screen, browser }) => {
    await browser.goto(content(`
      <button>Hi</button>
      <button aria-pressed="true">Hello</button>
      <button aria-pressed="false">Bye</button>
      <button aria-pressed="mixed">Mixed</button>
    `));
    expect(await screen.getByRole('button', { pressed: true }).allTextContents()).toEqual(['Hello']);
    expect(await screen.getByRole('button', { pressed: false }).allTextContents()).toEqual(['Hi', 'Bye']);
    expect(await screen.getByRole('button').allTextContents()).toEqual(['Hi', 'Hello', 'Bye', 'Mixed']);
  });

  test('should support expanded', async ({ screen, browser }) => {
    await browser.goto(content(`
      <div role="treeitem">Hi</div>
      <div role="treeitem" aria-expanded="true">Hello</div>
      <div role="treeitem" aria-expanded="false">Bye</div>
    `));

    expect(await screen.getByRole('treeitem').allTextContents()).toEqual(['Hi', 'Hello', 'Bye']);
    expect(await screen.getByRole('treeitem', { expanded: true }).allTextContents()).toEqual(['Hello']);
    expect(await screen.getByRole('treeitem', { expanded: false }).allTextContents()).toEqual(['Bye']);
    expect(await browser.locator('[role=treeitem]:not([aria-expanded])').allTextContents()).toEqual(['Hi']);
  });

  test('should support disabled', async ({ screen, browser }) => {
    await browser.goto(content(`
      <button>Hi</button>
      <button disabled>Bye</button>
      <button aria-disabled="true">Hello</button>
      <button aria-disabled="false">Oh</button>
      <fieldset disabled>
        <button>Yay</button>
      </fieldset>
      <select>
        <optgroup disabled>
          <option>one</option>
        </optgroup>
        <optgroup>
          <option>two</option>
        </optgroup>
        <option disabled>three</option>
      </select>
    `));
    expect(await screen.getByRole('button', { disabled: true }).allTextContents()).toEqual(['Bye', 'Hello', 'Yay']);
    expect(await screen.getByRole('button', { disabled: false }).allTextContents()).toEqual(['Hi', 'Oh']);
    expect(await screen.getByRole('option', { disabled: true }).allTextContents()).toEqual(['one', 'three']);
    expect(await screen.getByRole('option', { disabled: false }).allTextContents()).toEqual(['two']);
    expect(await screen.getByRole('option').allTextContents()).toEqual(['one', 'two', 'three']);
  });

  test('should inherit disabled from the ancestor', async ({ browser }) => {
    await browser.goto(content(`
      <span aria-disabled="true">
        <button>Click me!</button>
      </span>
    `));
    await expect(browser.locator('button')).toBeDisabled();

    await browser.goto(content(`
      <span aria-disabled="true">
        <h1>Heading</h1>
      </span>
    `));
    await expect(browser.locator('h1')).not.toBeDisabled();
  });

  test('should support disabled fieldset', async ({ screen, browser }) => {
    await browser.goto(content(`
      <fieldset disabled>
        <input></input>
        <button data-testid="inside-fieldset-element">x</button>
        <legend>
          <button data-testid="inside-legend-element">legend</button>
        </legend>
      </fieldset>

      <fieldset disabled>
        <legend>
          <div>
            <button data-testid="nested-inside-legend-element">x</button>
          </div>
        </legend>
      </fieldset>

      <fieldset disabled>
        <div></div>
        <legend>
          <button data-testid="first-legend-element">x</button>
        </legend>
        <legend>
          <button data-testid="second-legend-element">x</button>
        </legend>
      </fieldset>

      <fieldset disabled>
        <fieldset>
          <button data-testid="deep-button">x</button>
        </fieldset>
      </fieldset>
    `));

    await expect.soft(screen.getByTestId('inside-legend-element')).toBeEnabled();
    await expect.soft(screen.getByTestId('nested-inside-legend-element')).toBeEnabled();
    await expect.soft(screen.getByTestId('first-legend-element')).toBeEnabled();
    await expect.soft(screen.getByTestId('second-legend-element')).toBeDisabled();
    await expect.soft(screen.getByTestId('deep-button')).toBeDisabled();
  });

  test('should support level', async ({ screen, browser }) => {
    await browser.goto(content(`
      <h1>Hello</h1>
      <h3>Hi</h3>
      <div role="heading" aria-level="5">Bye</div>
    `));
    expect(await screen.getByRole('heading', { level: 1 }).allTextContents()).toEqual(['Hello']);
    expect(await screen.getByRole('heading', { level: 3 }).allTextContents()).toEqual(['Hi']);
    expect(await screen.getByRole('heading', { level: 5 }).allTextContents()).toEqual(['Bye']);
  });

  test('should filter hidden, unless explicitly asked for', async ({ screen, browser }) => {
    await browser.goto(content(`
      <button>Hi</button>
      <button hidden>Hello</button>
      <button aria-hidden="true">Yay</button>
      <button aria-hidden="false">Nay</button>
      <button style="visibility:hidden">Bye</button>
      <div style="visibility:hidden">
        <button>Oh</button>
      </div>
      <div style="visibility:hidden">
        <button style="visibility:visible">Still here</button>
      </div>
      <button style="display:none">Never</button>
      <div id=host1></div>
      <div id=host2 style="display:none"></div>

      <input name="one">
      <details>
        <summary>Open form</summary>
        <label>
           Label
           <input name="two">
        </label>
      </details>

      <select>
        <option style="visibility:hidden">One</option>
        <option style="display:none">Two</option>
        <option>Three</option>
      </select>

      <script>
        function addButton(host, text) {
          const root = host.attachShadow({ mode: 'open' });
          const button = document.createElement('button');
          button.textContent = text;
          root.appendChild(button);
        }
        addButton(document.getElementById('host1'), 'Shadow1');
        addButton(document.getElementById('host2'), 'Shadow2');
      </script>
    `));
    expect(await screen.getByRole('button').allTextContents()).toEqual(['Hi', 'Nay', 'Still here', 'Shadow1']);
    await expect(screen.getByRole('textbox')).toHaveCount(1);
    await expect(screen.getByRole('textbox')).toHaveAttribute('name', 'one');
    expect(await screen.getByRole('option').allTextContents()).toEqual(['One', 'Three']);
  });

  test('should support name', async ({ screen, browser }) => {
    await browser.goto(content(`
      <div role="button" aria-label=" Hello "></div>
      <div role="button" aria-label="Hallo"></div>
      <div role="button" aria-label="Hello" aria-hidden="true"></div>
      <div role="button" aria-label="123" aria-hidden="true"></div>
      <div role="button" aria-label='foo"bar' aria-hidden="true"></div>
    `));
    expect(await labels(screen.getByRole('button', { name: 'Hello' }))).toEqual([' Hello ']);
    expect(await labels(screen.getByRole('button', { name: ' \n Hello ' }))).toEqual([' Hello ']);
    expect(await labels(screen.getByRole('button', { name: 'Hello', exact: false }))).toEqual([' Hello ']);
    expect(await labels(screen.getByRole('button', { name: 'all', exact: false }))).toEqual(['Hallo']);
    expect(await labels(screen.getByRole('button', { name: /^H[ae]llo$/ }))).toEqual([' Hello ', 'Hallo']);
    expect(await labels(screen.getByRole('button', { name: /h.*o/i }))).toEqual([' Hello ', 'Hallo']);
  });

  test('should support option name with html whitespace', async ({ screen, browser }) => {
    await browser.goto(content(`
      <select>
        <option value="html">&nbsp;HTML</option>
      </select>
    `));
    await expect(screen.getByRole('option', { name: 'HTML', exact: false })).toHaveCount(1);
  });

  test('hidden with shadow dom slots', async ({ screen, browser }) => {
    await browser.goto(content(`
      <div make-hidden>
        <button>hidden1</button>
      </div>
      <div make-hidden>
        <span><button>hidden2</button></v>
      </div>
      <div>
        <button>visible1</button>
      </div>
      <div>
        <span><button>visible2</button></span>
      </div>
      <script>
        for (const div of document.querySelectorAll('div')) {
          const hidden = div.hasAttribute('make-hidden');
          div.attachShadow({ mode: 'open' }).innerHTML = hidden ? 'nothing to see here' : '<slot></slot>';
        }
      </script>
    `));
    expect(await screen.getByRole('button').allTextContents()).toEqual(['visible1', 'visible2']);
  });

  test('should support output accessible name', async ({ screen, browser }) => {
    await browser.goto(content(`<label>Output1<output>output</output></label>`));
    await expect(screen.getByRole('status', { name: 'Output1', exact: false })).toBeVisible();
  });

  test('should not match scope by default', async ({ screen, browser }) => {
    await browser.goto(content(`
      <ul>
        <li aria-label="Parent list">
          Parent list
          <ul>
            <li>child 1</li>
            <li>child 2</li>
          </ul>
        </li>
      </ul>
    `));
    const children = screen.getByRole('listitem', { name: 'Parent list', exact: false }).getByRole('listitem');
    await expect(children).toHaveCount(2);
    await expect(children).toHaveText(['child 1', 'child 2']);
  });
});
