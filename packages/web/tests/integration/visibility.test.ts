/**
 * The reader's `hidden` state, which `isVisible()`, `toBeVisible()`, and
 * `toBeHidden()` read, agrees with Playwright's own visibility on the cases
 * a rect count alone gets wrong: a hidden SVG, a zero-size box, closed
 * `<details>` content, and an empty `display: contents` element.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { captureDocument } from '../../src/observation.ts';
import { readManySemanticsFunction, SECURE_FIELD_SELECTOR } from '../../src/read-node.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

const READ_OPTIONS = {
  testIdAttribute: 'data-testid',
  secureFieldSelector: SECURE_FIELD_SELECTOR,
  mode: { kind: 'node' as const },
};

/** The reader's `hidden` state for one element next to what Playwright says of the same element. */
async function hiddenOf(selector: string): Promise<{ reader: boolean; playwright: boolean }> {
  const locator = page.locator(selector);
  const [raw] = await locator.evaluateAll(readManySemanticsFunction, READ_OPTIONS);
  return { reader: raw!.states.hidden, playwright: await locator.isHidden() };
}

const PAGE = `
  <svg id="svg-hidden" width="40" height="40" style="visibility:hidden"><rect width="40" height="40"></rect></svg>
  <svg id="svg-shown" width="40" height="40" role="img" aria-label="Logo"><rect width="40" height="40"></rect></svg>
  <div id="zero" style="width:0;height:0;overflow:hidden"><button>Clipped</button></div>
  <div id="sized" style="width:40px;height:40px;overflow:hidden"><button>Shown</button></div>
  <details id="closed"><summary>More</summary><button id="in-closed">Inside closed</button></details>
  <details id="open" open><summary>More</summary><button id="in-open">Inside open</button></details>
  <details><summary>Outer</summary><details id="nested" open><summary>Inner</summary><button id="in-nested">Nested</button></details></details>
  <div id="contents-empty" style="display:contents"></div>
  <div id="contents-hidden-child" style="display:contents"><span style="display:none">gone</span></div>
  <div id="contents-painted" style="display:contents"><button>Painted</button></div>
  <div id="contents-text" style="display:contents">bare text</div>
`;

describe('visibility agrees with Playwright', () => {
  beforeAll(async () => {
    await page.setContent(PAGE);
  });

  it.each([
    ['an SVG with visibility: hidden', '#svg-hidden', true],
    ['a shown SVG', '#svg-shown', false],
    ['a zero-size box with clipped content', '#zero', true],
    ['the button clipped inside a zero-size box, which keeps a box of its own', '#zero button', false],
    ['a sized box', '#sized', false],
    ['a button inside closed details', '#in-closed', true],
    ['the summary of closed details', '#closed summary', false],
    ['a button inside open details', '#in-open', false],
    ['open details nested in the body of closed details', '#nested', true],
    ['the summary of details nested in closed details', '#nested summary', true],
    ['a button inside open details nested in closed details', '#in-nested', true],
    ['an empty display: contents element', '#contents-empty', true],
    ['a display: contents element whose only child is hidden', '#contents-hidden-child', true],
    ['a display: contents element with a painted child', '#contents-painted', false],
    ['a display: contents element with bare text', '#contents-text', false],
  ])('%s', async (_case, selector, hidden) => {
    expect(await hiddenOf(selector)).toEqual({ reader: hidden, playwright: hidden });
  });
});

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** One observation of the page through the same capture the engine uses, frames included. */
async function captureTree(): Promise<SemanticNode[]> {
  let nextId = 1;
  const { tree } = await captureDocument(
    {
      testIdAttribute: 'data-testid',
      site: undefined,
      reserveIds: (count) => { const first = nextId; nextId += count; return first; },
      commit: () => undefined,
    },
    page,
    { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal },
  );
  return flatten(tree);
}

describe('the tree walk through a box with no size', () => {
  it('lists the fixed controls under a zero-height page and wrapper, and neither the wrapper nor the root as hidden', async () => {
    await page.setContent(`
      <nav aria-label="Floating" data-testid="wrapper">
        <button style="position:fixed;left:0;top:0;width:100px;height:30px">Reset</button>
      </nav>
    `);
    const nodes = await captureTree();
    expect(nodes[0]!.states?.hidden).toBeUndefined();
    expect(nodes.find((node) => node.role === 'button')?.name).toBe('Reset');
    expect(nodes.find((node) => node.testId === 'wrapper')).toBeUndefined();
  });

  it('lists neither the document of a frame with no box nor the options of a select with none', async () => {
    await page.setContent(`
      <iframe style="width:0;height:0;border:0" srcdoc="<button>Pay</button>"></iframe>
      <iframe style="width:200px;height:100px" srcdoc="<button>Shown pay</button>"></iframe>
      <select aria-label="Folded" style="width:0;height:0;padding:0;border:0"><option>plain</option><option>warm</option></select>
      <select aria-label="Shown"><option>cool</option></select>
    `);
    await Promise.all(page.frames().slice(1).map((frame) => frame.waitForLoadState()));
    const nodes = await captureTree();
    const buttons = nodes.filter((node) => node.role === 'button').map((node) => node.name);
    const options = nodes.filter((node) => node.role === 'option').map((node) => node.name);
    expect(buttons).toEqual(['Shown pay']);
    expect(options).toEqual(['cool']);
    expect(nodes.filter((node) => node.role === 'combobox').map((node) => node.name)).toEqual(['Shown']);
  });
});

describe('an inert subtree', () => {
  it('leaves the tree, as Chrome drops it, while Playwright still calls it visible', async () => {
    await page.setContent(`
      <main inert><h2>Behind the drawer</h2><button id="inert-save">Save</button></main>
      <button>Close drawer</button>
    `);
    const names = (await captureTree()).map((node) => node.name).filter((name) => name !== undefined);
    expect(names).toContain('Close drawer');
    expect(names).not.toContain('Save');
    expect(names).not.toContain('Behind the drawer');
    expect(await hiddenOf('#inert-save')).toEqual({ reader: false, playwright: false });
  });

  it('lists nothing under an inert document root, and nothing slotted into an inert slot of a closed root', async () => {
    await page.setContent('<!doctype html><html inert><body><button>Whole page</button></body></html>');
    expect((await captureTree()).filter((node) => node.role === 'button')).toEqual([]);
    await page.setContent(`
      <inert-slot><button>Slotted</button></inert-slot>
      <button>Outside</button>
      <script>
        customElements.define('inert-slot', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'closed' }).innerHTML = '<div inert><slot></slot></div>'; }
        });
      </script>
    `);
    const buttons = (await captureTree()).filter((node) => node.role === 'button').map((node) => node.name);
    expect(buttons).toEqual(['Outside']);
  });
});
