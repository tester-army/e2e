/**
 * The reader's `hidden` state, which `isVisible()`, `toBeVisible()`, and
 * `toBeHidden()` read, agrees with Playwright's own visibility on the cases
 * a rect count alone gets wrong: a hidden SVG, a zero-size box, closed
 * `<details>` content, an empty `display: contents` element, skipped
 * `content-visibility` content, and an `aria-hidden` node that still paints.
 * The tree walk keeps `aria-hidden` subtrees out while it walks into a
 * `visibility: hidden` one a child shows again.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { captureDocument } from '../../src/observation.ts';
import { readSemanticsFunction } from '../../src/in-page/read-semantics.ts';
import { SECURE_FIELD_SELECTOR } from '../../src/read-node.ts';

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
  const raw = await locator.evaluate(readSemanticsFunction<typeof READ_OPTIONS.mode>, READ_OPTIONS);
  return { reader: raw.states.hidden, playwright: await locator.isHidden() };
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
  <div id="contents-hidden-element" style="display:contents;visibility:hidden"><span>hidden span</span></div>
  <div id="contents-shown-child" style="display:contents;visibility:hidden"><span style="visibility:visible">shown span</span></div>
  <div id="spinner" aria-hidden="true" style="width:40px;height:40px;background:#888">spinning</div>
  <div aria-hidden="true"><button id="under-aria-hidden">Decorative</button></div>
  <div id="skipping" style="content-visibility:hidden;width:50px;height:50px"><button id="skipped">Skipped</button></div>
  <skip-host id="skipping-host" style="content-visibility:hidden;display:block;width:50px;height:50px"><button id="skipped-slotted">Slotted</button></skip-host>
  <div id="vis-parent" style="visibility:hidden"><button id="vis-child" style="visibility:visible">Shown child</button></div>
  <script>
    customElements.define('skip-host', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div><slot></slot></div>'; }
    });
  </script>
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
    ['a hidden display: contents element whose child inherits it', '#contents-hidden-element', true],
    ['a hidden display: contents element whose child is visible again', '#contents-shown-child', false],
    ['an aria-hidden spinner that paints', '#spinner', false],
    ['a button under an aria-hidden container', '#under-aria-hidden', false],
    ['a content-visibility: hidden element, which keeps its box', '#skipping', false],
    ['a button content-visibility: hidden skips', '#skipped', true],
    ['a button slotted under a content-visibility: hidden host', '#skipped-slotted', true],
    ['a visibility: hidden parent', '#vis-parent', true],
    ['a child that sets visibility: visible under a hidden parent', '#vis-child', false],
  ])('%s', async (_case, selector, hidden) => {
    expect(await hiddenOf(selector)).toEqual({ reader: hidden, playwright: hidden });
  });
});

describe('visibility where Playwright reads a range box alone', () => {
  it('hides text under a display: contents element whose visibility is hidden, which Playwright calls visible', async () => {
    await page.setContent('<div id="contents-hidden-text" style="display:contents;visibility:hidden">Invisible text</div>');
    expect(await hiddenOf('#contents-hidden-text')).toEqual({ reader: true, playwright: false });
  });
});

describe('the bounding box', () => {
  /** The reader's rect for one element next to Playwright's `boundingBox()`. */
  async function boxOf(selector: string) {
    const locator = page.locator(selector);
    const raw = await locator.evaluate(readSemanticsFunction<typeof READ_OPTIONS.mode>, READ_OPTIONS);
    return { reader: raw.rect, playwright: await locator.boundingBox() };
  }

  it.each([
    ['display: none', '<div id="box" style="display:none">gone</div>', null],
    ['under a display: none ancestor', '<div style="display:none"><span id="box">gone</span></div>', null],
    ['an empty display: contents element', '<div id="box" style="display:contents"></div>', null],
    ['display: contents around text', '<div id="box" style="display:contents">text</div>', null],
    ['visibility: hidden, which keeps its box', '<div id="box" style="visibility:hidden;width:30px;height:20px"></div>', { width: 30, height: 20 }],
    ['a zero-size box', '<div id="box" style="width:0;height:0"></div>', { width: 0, height: 0 }],
  ])('%s', async (_case, html, size) => {
    await page.setContent(`<body style="margin:0">${html}</body>`);
    const { reader, playwright } = await boxOf('#box');
    expect(reader).toEqual(playwright);
    expect(reader === null ? null : { width: reader.width, height: reader.height }).toEqual(size);
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

describe('the tree walk through hidden content', () => {
  it('walks into a visibility: hidden subtree for a child that shows again, and stops at aria-hidden and skipped content', async () => {
    await page.setContent(`
      <div style="visibility:hidden"><button>Hidden parent</button><div><button style="visibility:visible">Shown child</button></div></div>
      <div aria-hidden="true"><button>Decorative</button></div>
      <div style="content-visibility:hidden;width:50px;height:50px" data-testid="skipping">Skipped text<button>Skipped</button></div>
      <div style="display:contents;visibility:hidden"><button>Contents hidden</button></div>
    `);
    const nodes = await captureTree();
    const buttons = nodes.filter((node) => node.role === 'button');
    expect(buttons.map((node) => [node.name, node.states?.hidden])).toEqual([['Shown child', undefined]]);
    const skipping = nodes.find((node) => node.testId === 'skipping');
    expect(skipping?.states?.hidden).toBeUndefined();
    // The container keeps its box and paints none of its text, which innerText reads empty too.
    expect(skipping?.text).toBe('');
    expect(await page.getByTestId('skipping').innerText()).toBe('');
  });
});
