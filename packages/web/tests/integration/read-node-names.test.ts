/** The real reader names unlabeled text controls by placeholder, controls by their descendants, and reports a cut walk. */

import { chromium, type Browser, type ElementHandle, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
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

/** One observation of the page through the same capture the engine uses. */
async function capture(budget = 100) {
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
    { framePath: [], budget, deadline: Date.now() + 10_000, signal: new AbortController().signal },
  );
  await Promise.all([...published.values()].map((element) => element.dispose()));
  return captured;
}

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

describe('placeholder names', () => {
  it('names text controls by placeholder in HTML-AAM order and carries the attribute', async () => {
    await page.setContent(`
      <input type="search" placeholder="Search products" data-testid="search">
      <textarea placeholder="Leave a note" data-testid="note"></textarea>
      <label for="email">Email</label><input id="email" type="email" placeholder="you@example.test">
      <input type="text" title="Promo code" placeholder="Enter code" data-testid="promo">
      <input type="text" aria-placeholder="Amount" data-testid="amount">
      <input type="checkbox" placeholder="Not a text control" data-testid="check">
    `);
    const { tree, truncated } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    const email = flatten(tree).find((node) => node.name === 'Email');

    expect(byTestId.get('search')).toMatchObject({ role: 'searchbox', name: 'Search products' });
    expect(byTestId.get('search')?.attributes?.['placeholder']).toBe('Search products');
    expect(byTestId.get('note')).toMatchObject({ role: 'textbox', name: 'Leave a note' });
    // A label wins over the placeholder; the placeholder still rides along as an attribute.
    expect(email).toMatchObject({ role: 'textbox', name: 'Email' });
    expect(email?.attributes?.['placeholder']).toBe('you@example.test');
    // The title comes before the placeholder, the aria-placeholder after it.
    expect(byTestId.get('promo')?.name).toBe('Promo code');
    expect(byTestId.get('amount')?.name).toBe('Amount');
    // Only text-like controls are placeholder-named.
    expect(byTestId.get('check')?.name).toBeUndefined();
    expect(truncated).toBe(false);
  });
});

describe('truncated flag', () => {
  it('reports a walk the node budget stopped, and a whole read as not truncated', async () => {
    const buttons = Array.from({ length: 20 }, (_, index) => `<button>Button ${String(index)}</button>`).join('');
    await page.setContent(`<main>${buttons}</main>`);

    const whole = await capture(100);
    expect(whole.truncated).toBe(false);
    expect(whole.nodeCount).toBe(22);

    const cut = await capture(5);
    expect(cut.truncated).toBe(true);
    expect(cut.nodeCount).toBe(5);
  });

  it('reports a child frame the budget could not enter', async () => {
    await page.setContent(`
      <button>One</button>
      <iframe srcdoc="<button>Inside</button>"></iframe>
    `);
    await page.frames()[1]?.waitForLoadState('domcontentloaded');
    const whole = await capture(100);
    expect(whole.truncated).toBe(false);
    expect(flatten(whole.tree).some((node) => node.name === 'Inside')).toBe(true);

    // Root, button, iframe: exactly the budget, nothing left for the frame's document.
    const cut = await capture(3);
    expect(cut.truncated).toBe(true);
    expect(flatten(cut.tree).some((node) => node.name === 'Inside')).toBe(false);
  });

  it('does not count an off-site frame it leaves out by design, even with no budget left', async () => {
    // With no site every non-blank URL is off-site; a data: document is never entered.
    await page.setContent(`
      <button>One</button>
      <iframe src="data:text/html,<button>Ad</button>"></iframe>
    `);
    await page.frames()[1]?.waitForLoadState('domcontentloaded');
    const cut = await capture(3);
    expect(cut.nodeCount).toBe(3);
    expect(cut.truncated).toBe(false);
  });

  it('reports an on-site frame past the depth limit as truncation', async () => {
    await page.setContent('<button>Top</button>');
    // Nest same-origin srcdoc frames one deeper than the capture follows.
    const nest = async (depth: number): Promise<void> => {
      await page.evaluate(async (levels) => {
        let doc = document;
        for (let level = 0; level < levels; level += 1) {
          const iframe = doc.createElement('iframe');
          iframe.srcdoc = `<button>Level ${String(level + 1)}</button>`;
          doc.body.appendChild(iframe);
          await new Promise<void>((resolve) => { iframe.addEventListener('load', () => resolve(), { once: true }); });
          doc = iframe.contentDocument!;
        }
      }, depth);
    };
    await nest(4);
    const within = await capture(1_000);
    expect(within.truncated).toBe(false);
    expect(flatten(within.tree).some((node) => node.name === 'Level 4')).toBe(true);

    await page.setContent('<button>Top</button>');
    await nest(5);
    const beyond = await capture(1_000);
    expect(beyond.truncated).toBe(true);
    expect(flatten(beyond.tree).some((node) => node.name === 'Level 5')).toBe(false);
  });
});

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7';

describe('names from content and precedence', () => {
  /** The test id of the one element Playwright's role selector resolves for this role and exact name. */
  async function locatedTestId(role: string, name: string): Promise<string | null> {
    return page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true }).getAttribute('data-testid');
  }

  it('names a control from its descendants the way the role selector does: aria-label, alt, content, then title', async () => {
    await page.setContent(`
      <button data-testid="img"><img src="${PIXEL}" alt="Search"></button>
      <button data-testid="svg"><svg aria-label="Close" width="10" height="10"></svg></button>
      <button data-testid="nested"><span><img src="${PIXEL}" alt="Deep"></span></button>
      <button data-testid="labelled-span"><span aria-label="Inner"><b>Bold</b></span></button>
      <button data-testid="mixed"><img src="${PIXEL}" alt="Search">Go</button>
      <button data-testid="blocks"><div>A</div><div>B</div></button>
      <button data-testid="titled"><span title="Settings"></span></button>
      <button data-testid="text-over-title"><span title="Tip">Visible</span></button>
      <button data-testid="hidden"><img src="${PIXEL}" alt="Hidden" style="display:none"><span aria-hidden="true">x</span><img src="${PIXEL}" alt="Kept"></button>
      <a href="#" data-testid="link"><img src="${PIXEL}" alt="Home"></a>
      <input type="image" src="${PIXEL}" alt="Go" data-testid="image-input">
    `);
    const { tree } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, role: 'button' | 'link', name: string][] = [
      ['img', 'button', 'Search'],
      ['svg', 'button', 'Close'],
      ['nested', 'button', 'Deep'],
      ['labelled-span', 'button', 'Inner'],
      ['mixed', 'button', 'SearchGo'],
      ['blocks', 'button', 'A B'],
      ['titled', 'button', 'Settings'],
      ['text-over-title', 'button', 'Visible'],
      ['hidden', 'button', 'Kept'],
      ['link', 'link', 'Home'],
      ['image-input', 'button', 'Go'],
    ];
    for (const [testId, role, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role, name });
      expect(await locatedTestId(role, name), name).toBe(testId);
    }
  });

  it('reads an embedded control by its value, as the role selector does', async () => {
    await page.setContent(`
      <button data-testid="textbox">Flash the screen <input value="3"> times</button>
      <button data-testid="search">Find <input type="search" value="q"> now</button>
      <button data-testid="textarea">Note <textarea>hi</textarea> end</button>
      <button data-testid="aria-label-ignored">Name <input aria-label="ignored" value="v"> end</button>
      <button data-testid="select">Pick <select><option>A</option><option selected>B</option></select> now</button>
      <div role="button" data-testid="no-selection">Choose <select><option>A</option><option>B</option></select> now</div>
      <div role="button" data-testid="multiple">Pick <select multiple><option selected>A</option><option selected>B</option></select> now</div>
      <div role="button" data-testid="aria-listbox">Pick <div role="listbox"><div role="option" aria-selected="true">X</div><div role="option">Y</div></div> now</div>
      <div role="button" data-testid="datalist">Find <input list="choices" value="dv"><datalist id="choices"><option>o</option></datalist> now</div>
      <button data-testid="range">Vol <input type="range" min="0" max="10" value="4"> end</button>
      <button data-testid="valuetext">Bass <input type="range" aria-valuetext="four" min="0" max="10" value="4"> end</button>
      <div role="button" data-testid="no-value-attribute">Volume <input type="range" min="0" max="10"> end</div>
      <div role="button" data-testid="spinbutton">Count <input type="number" value="7"> end</div>
      <div role="button" data-testid="progress">Load <progress value="30" max="100"></progress> end</div>
      <div role="button" data-testid="checkbox">Agree <input type="checkbox"> end</div>
      <div role="button" data-testid="hidden-control">Gain <input value="zz" style="display:none"> end</div>
      <div role="button" data-testid="aria-hidden-control">Level <input value="zz" aria-hidden="true"> end</div>
      <span id="count">Count <input value="2"> rows</span><button aria-labelledby="count" data-testid="referenced">z</button>
      <label for="qty">Qty <input value="5"> items</label><input id="qty" data-testid="label-for">
      <label>Inside <input value="9" data-testid="own-label"></label>
    `);
    const { tree } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, role: 'button' | 'textbox', name: string][] = [
      ['textbox', 'button', 'Flash the screen 3 times'],
      ['search', 'button', 'Find q now'],
      ['textarea', 'button', 'Note hi end'],
      // An embedded control's value comes before its aria-label.
      ['aria-label-ignored', 'button', 'Name v end'],
      ['select', 'button', 'Pick B now'],
      ['no-selection', 'button', 'Choose A now'],
      ['multiple', 'button', 'Pick A B now'],
      ['aria-listbox', 'button', 'Pick X now'],
      ['datalist', 'button', 'Find dv now'],
      ['range', 'button', 'Vol 4 end'],
      ['valuetext', 'button', 'Bass four end'],
      ['no-value-attribute', 'button', 'Volume end'],
      ['spinbutton', 'button', 'Count 7 end'],
      ['progress', 'button', 'Load 30 end'],
      ['checkbox', 'button', 'Agree end'],
      ['hidden-control', 'button', 'Gain end'],
      ['aria-hidden-control', 'button', 'Level end'],
      ['referenced', 'button', 'Count 2 rows'],
      ['label-for', 'textbox', 'Qty 5 items'],
      // A control inside its own label is the name's subject, never part of it.
      ['own-label', 'textbox', 'Inside'],
    ];
    for (const [testId, role, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role, name });
      expect(await locatedTestId(role, name), name).toBe(testId);
    }
  });

  it('keeps an embedded control\'s value out of label text and a secure field\'s value out of every name', async () => {
    await page.setContent(`
      <label for="qty">Qty <input value="5"> items</label><input id="qty" data-testid="label-for">
      <button data-testid="secure">Unlock <input type="password" value="hunter2"> now</button>
      <label for="pin">PIN <input type="password" value="hunter2"> field</label><input id="pin" data-testid="secure-label">
    `);
    const options = { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, mode: { kind: 'node' as const } };
    const reads = await Promise.all(
      (await page.locator('[data-testid]').all()).map((locator) => locator.evaluate(readSemanticsFunction<typeof options.mode>, options)),
    );
    const byTestId = new Map(reads.map((raw) => [raw.testId, raw] as const));
    // Label text is what Playwright's getByLabel matches, which reads no control value.
    expect(byTestId.get('label-for')?.labels).toEqual(['Qty items']);
    expect(await page.getByLabel('Qty items', { exact: true }).getAttribute('data-testid')).toBe('label-for');
    expect(byTestId.get('secure')?.name).toBe('Unlock now');
    expect(byTestId.get('secure-label')?.name).toBe('PIN field');
    expect(JSON.stringify(reads)).not.toContain('hunter2');
  });

  it('reads aria-labelledby before aria-label, and either before a label element', async () => {
    await page.setContent(`
      <span id="heading">Shipping address</span>
      <input aria-labelledby="heading" aria-label="Address" data-testid="referenced">
      <label for="named">Label text</label><input id="named" aria-label="Aria text" data-testid="labelled">
      <span id="first">First</span><span id="second"><img src="${PIXEL}" alt="Pic"></span>
      <button aria-labelledby="first second" data-testid="two-references">x</button>
    `);
    const { tree } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    expect(byTestId.get('referenced')).toMatchObject({ role: 'textbox', name: 'Shipping address' });
    expect(byTestId.get('labelled')).toMatchObject({ role: 'textbox', name: 'Aria text' });
    expect(byTestId.get('two-references')).toMatchObject({ role: 'button', name: 'First Pic' });
    expect(await locatedTestId('textbox', 'Shipping address')).toBe('referenced');
    expect(await locatedTestId('textbox', 'Aria text')).toBe('labelled');
    expect(await locatedTestId('button', 'First Pic')).toBe('two-references');
    expect(await page.getByRole('textbox', { name: 'Address', exact: true }).count()).toBe(0);
  });

  it('reads a referenced target whole when it is hidden, by its own aria-label, and drops hidden parts of a shown one', async () => {
    await page.setContent(`
      <button aria-labelledby="l1" aria-label="Delete" data-testid="hidden-reference"><span id="l1" hidden>Delete account</span></button>
      <button aria-labelledby="l2" aria-label="Delete" data-testid="aria-hidden-reference"><span id="l2" aria-hidden="true">Remove account</span></button>
      <button aria-labelledby="l3" data-testid="nested-hidden-reference">x</button>
      <div hidden><span id="l3">Deep <i style="display:none">gone</i>label</span></div>
      <button aria-labelledby="l4" data-testid="shown-reference">x</button>
      <span id="l4">Shown <i style="display:none">gone</i></span>
      <button aria-labelledby="l5" data-testid="labelled-reference">x</button>
      <span id="l5" aria-label="Own label">Text</span>
      <button aria-labelledby="l6" data-testid="aria-hidden-ancestor-reference">x</button>
      <div aria-hidden="true"><span id="l6">Label <i style="display:none">gone</i></span></div>
    `);
    const { tree } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, name: string][] = [
      ['hidden-reference', 'Delete account'],
      ['aria-hidden-reference', 'Remove account'],
      ['nested-hidden-reference', 'Deep gone label'],
      ['shown-reference', 'Shown'],
      ['labelled-reference', 'Own label'],
      // An aria-hidden ancestor hides the target as its own attribute would, so it is read whole.
      ['aria-hidden-ancestor-reference', 'Label gone'],
    ];
    for (const [testId, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role: 'button', name });
      expect(await locatedTestId('button', name), name).toBe(testId);
    }
  });

  it('resolves an aria-labelledby id in the element\'s own shadow tree, not the document', async () => {
    await page.setContent(`
      <span id="l">Outside</span>
      <x-host></x-host>
      <script>
        const root = document.querySelector('x-host').attachShadow({ mode: 'open' });
        root.innerHTML = '<span id="l">Inside</span><button aria-labelledby="l" data-testid="inside">x</button>';
      </script>
    `);
    const { tree } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    expect(byTestId.get('inside')).toMatchObject({ role: 'button', name: 'Inside' });
    expect(await locatedTestId('button', 'Inside')).toBe('inside');
  });

  it('follows a descendant reference in a name from content, once per element and never from inside another', async () => {
    await page.setContent(`
      <button data-testid="svg-reference"><svg aria-labelledby="t1" width="10" height="10"><title id="t1">Close</title></svg>Icon</button>
      <button data-testid="block-svg-reference"><svg aria-labelledby="t2" style="display:block" width="10" height="10"><title id="t2">Close</title></svg>Icon</button>
      <button data-testid="svg-title"><svg width="10" height="10"><title>Svg title</title></svg></button>
      <button data-testid="two-references"><span aria-labelledby="p1 p2"></span></button>
      <span id="p1">One</span><span id="p2">Two</span>
      <button data-testid="hidden-target"><span aria-labelledby="p3"></span></button>
      <span id="p3" hidden>Hidden target</span>
      <button data-testid="cycle"><span id="c1" aria-labelledby="c2">A</span><span id="c2" aria-labelledby="c1">B</span></button>
      <button id="ancestor" data-testid="ancestor-reference"><span aria-labelledby="ancestor">A</span>B</button>
      <button id="me" aria-labelledby="me" data-testid="self-reference">Self</button>
      <button aria-labelledby="r1" data-testid="nested-reference">x</button>
      <span id="r1"><span aria-labelledby="r2">Ref text</span></span><span id="r2">Nested</span>
    `);
    const { tree } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, name: string][] = [
      ['svg-reference', 'CloseIcon'],
      ['block-svg-reference', 'Close Icon'],
      ['svg-title', 'Svg title'],
      ['two-references', 'One Two'],
      ['hidden-target', 'Hidden target'],
      ['cycle', 'B'],
      ['ancestor-reference', 'AB'],
      ['self-reference', 'Self'],
      ['nested-reference', 'Ref text'],
    ];
    for (const [testId, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role: 'button', name });
      expect(await locatedTestId('button', name), name).toBe(testId);
    }
  });

  it('names every role accname allows from content, a shadow tree included, and a reset input by its value or default', async () => {
    // The init script that records closed roots runs on a navigation; setContent alone is none.
    await page.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
    await page.goto('about:blank');
    await page.setContent(`
      <div role="checkbox" aria-checked="false" data-testid="checkbox">Remember me</div>
      <span role="radio" aria-checked="true" data-testid="radio">Monthly</span>
      <div role="switch" aria-checked="false" data-testid="switch">Dark mode</div>
      <table>
        <tr><th data-testid="columnheader">Price</th><th scope="row" data-testid="rowheader">Ada</th><td data-testid="cell">42</td></tr>
      </table>
      <div role="grid"><div role="row" data-testid="row"><div role="gridcell" data-testid="gridcell">A1</div></div></div>
      <x-button role="button" tabindex="0" data-testid="custom-button"><span slot="icon">*</span></x-button>
      <x-label role="button" tabindex="0" data-testid="slotted-button">Slotted</x-label>
      <x-action role="button" tabindex="0" data-testid="closed-slotted-button">Save</x-action>
      <input type="reset" value="Clear" data-testid="reset-value">
      <input type="reset" data-testid="reset-default">
      <input type="submit" data-testid="submit-default">
      <button data-testid="plain">Plain</button>
      <input type="submit" value="Send" data-testid="submit-value">
      <script>
        document.querySelector('x-button').attachShadow({ mode: 'open' }).innerHTML = '<slot name="icon"></slot><span>Custom</span>';
        document.querySelector('x-label').attachShadow({ mode: 'open' }).innerHTML = '<b>[</b><slot></slot><b>]</b>';
        document.querySelector('x-action').attachShadow({ mode: 'closed' }).innerHTML = '<b>[</b><slot></slot><b>]</b>';
      </script>
    `);
    const { tree } = await capture();
    const byTestId = new Map(flatten(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, role: string, name: string][] = [
      ['checkbox', 'checkbox', 'Remember me'],
      ['radio', 'radio', 'Monthly'],
      ['switch', 'switch', 'Dark mode'],
      ['columnheader', 'columnheader', 'Price'],
      ['rowheader', 'rowheader', 'Ada'],
      ['cell', 'cell', '42'],
      ['row', 'row', 'A1'],
      ['gridcell', 'gridcell', 'A1'],
      ['custom-button', 'button', '* Custom'],
      ['slotted-button', 'button', '[ Slotted ]'],
      ['reset-value', 'button', 'Clear'],
      ['reset-default', 'button', 'Reset'],
      ['submit-default', 'button', 'Submit'],
      ['plain', 'button', 'Plain'],
      ['submit-value', 'button', 'Send'],
    ];
    for (const [testId, role, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role, name });
      expect(await locatedTestId(role, name), name).toBe(testId);
    }
    // A closed root's slot lists its assigned nodes while the light child's
    // `assignedSlot` reads null from outside, so the slotted text is read once,
    // at the slot. Playwright's role selector cannot see a closed root and
    // names the host "Save", so there is no locator to compare against.
    expect(byTestId.get('closed-slotted-button')).toMatchObject({ role: 'button', name: '[ Save ]' });
  });
});
