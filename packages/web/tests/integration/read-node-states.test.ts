/** The real reader's `disabled` state is the effective one: a control inherits it from a disabled fieldset and from an `aria-disabled` ancestor, as the browser and Playwright report it. */

import { chromium, type Browser, type ElementHandle, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { captureDocument } from '../../src/observation.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

/** One observation of the page through the same capture the engine uses. */
async function capture() {
  let nextId = 1;
  const published = new Map<string, ElementHandle<Element>>();
  const captured = await captureDocument(
    {
      testIdAttribute: 'data-testid',
      site: undefined,
      reserveIds: (count) => { const first = nextId; nextId += count; return first; },
      commit: (id, element) => { published.set(id, element); },
    },
    page,
    { framePath: [], budget: 200, deadline: Date.now() + 10_000, signal: new AbortController().signal },
  );
  await Promise.all([...published.values()].map((element) => element.dispose()));
  return captured;
}

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** The `disabled` state per test id, `false` when the node reports none. */
async function disabledByTestId(): Promise<Map<string, boolean>> {
  const { tree } = await capture();
  return new Map(
    flatten(tree)
      .filter((node) => node.testId !== undefined)
      .map((node) => [node.testId!, node.states?.disabled === true]),
  );
}

/** Playwright's answer for the same elements, the reference the reader must agree with. */
async function expectAgreesWithPlaywright(states: Map<string, boolean>): Promise<void> {
  for (const [testId, disabled] of states) {
    expect(await page.getByTestId(testId).isDisabled(), testId).toBe(disabled);
  }
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
    await expectAgreesWithPlaywright(states);
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
    states.delete('inner-fieldset');
    await expectAgreesWithPlaywright(states);
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
    states.delete('host');
    await expectAgreesWithPlaywright(states);
  });
});
