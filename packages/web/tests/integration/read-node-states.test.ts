/** The real reader's `disabled` state is the effective one: a control inherits it from a disabled fieldset and from an `aria-disabled` ancestor, as the browser reports it. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession();
});

afterAll(async () => {
  await page.close();
});

/** The `disabled` state per test id, `false` when the node reports none. */
async function disabledByTestId(): Promise<Map<string, boolean>> {
  return new Map(
    (await page.nodes())
      .filter((node) => node.testId !== undefined)
      .map((node) => [node.testId!, node.states?.disabled === true]),
  );
}

describe('disabled state', () => {
  it('inherits from a disabled fieldset, except inside its first legend', async () => {
    await page.setContent(`
      <fieldset disabled>
        <legend>Billing <button data-testid="legend-action">Edit</button></legend>
        <label>Card <input data-testid="fenced-input"></label>
        <button data-testid="fenced-button">Pay</button>
        <select data-testid="fenced-select"><option>One</option></select>
        <textarea data-testid="fenced-textarea"></textarea>
        <legend>Second <button data-testid="second-legend-action">Not exempt</button></legend>
      </fieldset>
      <fieldset>
        <legend>Shipping</legend>
        <button data-testid="free-button">Ship</button>
      </fieldset>
      <button data-testid="own-disabled" disabled>Own</button>
      <button data-testid="own-enabled">Enabled</button>
    `);
    const states = await disabledByTestId();
    expect(Object.fromEntries(states)).toEqual({
      'legend-action': false,
      'fenced-input': true,
      'fenced-button': true,
      'fenced-select': true,
      'fenced-textarea': true,
      'second-legend-action': true,
      'free-button': false,
      'own-disabled': true,
      'own-enabled': false,
    });
  });

  it('follows nested fieldsets: an inner legend frees nothing from an outer disabled fieldset', async () => {
    await page.setContent(`
      <fieldset disabled>
        <legend>Outer</legend>
        <fieldset data-testid="inner-fieldset">
          <legend>Inner <button data-testid="inner-legend-action">Still fenced</button></legend>
          <button data-testid="inner-button">Fenced twice</button>
        </fieldset>
      </fieldset>
      <fieldset>
        <legend>Outer open</legend>
        <fieldset disabled>
          <legend>Inner closed <button data-testid="closed-legend-action">Free</button></legend>
          <button data-testid="closed-button">Fenced</button>
        </fieldset>
      </fieldset>
    `);
    const states = await disabledByTestId();
    expect(Object.fromEntries(states)).toMatchObject({
      'inner-legend-action': true,
      'inner-button': true,
      'closed-legend-action': false,
      'closed-button': true,
    });
  });

  it('inherits aria-disabled from an ancestor, across a shadow root, until an aria-disabled="false" cuts the chain', async () => {
    await page.setContent(`
      <div aria-disabled="true">
        <button data-testid="under-aria">Save</button>
        <div role="group" aria-disabled="false">
          <button data-testid="reenabled">Cancel</button>
        </div>
        <span data-testid="plain-text">Just text</span>
        <x-host data-testid="host"></x-host>
      </div>
      <div role="toolbar" aria-disabled="true" data-testid="own-aria">
        <button data-testid="in-toolbar">Bold</button>
      </div>
      <button data-testid="outside">Outside</button>
      <script>
        const host = document.querySelector('x-host');
        const root = host.attachShadow({ mode: 'open' });
        const button = document.createElement('button');
        button.textContent = 'Shadow';
        button.setAttribute('data-testid', 'in-shadow');
        root.appendChild(button);
      </script>
    `);
    const states = await disabledByTestId();
    expect(Object.fromEntries(states)).toMatchObject({
      'under-aria': true,
      reenabled: false,
      'plain-text': false,
      'in-shadow': true,
      'own-aria': true,
      'in-toolbar': true,
      outside: false,
    });
  });
});
