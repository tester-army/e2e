/** The real reader names unlabeled text controls by placeholder, controls by their descendants, and reports a cut walk. */

import { chromium, type Browser, type ElementHandle, type Page } from 'playwright';
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
  async function locatedTestId(role: 'button' | 'link' | 'textbox', name: string): Promise<string | null> {
    return page.getByRole(role, { name, exact: true }).getAttribute('data-testid');
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
});
