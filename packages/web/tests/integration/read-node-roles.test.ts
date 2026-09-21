/** The real reader maps explicit ARIA roles and implicit HTML semantics onto the vocabulary. */

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

/** Roles by test id, for a page whose every element of interest carries one. */
async function rolesByTestId(): Promise<Map<string, SemanticNode>> {
  const { tree } = await capture();
  return new Map(flatten(tree).filter((node) => node.testId !== undefined).map((node) => [node.testId!, node]));
}

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7';

describe('role mapping', () => {
  it('reports ARIA img as image, alongside the img element', async () => {
    await page.setContent(`
      <img src="${PIXEL}" alt="Logo" data-testid="picture">
      <div role="img" aria-label="Chart" data-testid="drawn"></div>
      <svg role="img" aria-label="Icon" width="10" height="10" data-testid="vector"></svg>
      <img src="${PIXEL}" alt="">
    `);
    const nodes = await rolesByTestId();
    expect(nodes.get('picture')).toMatchObject({ role: 'image', name: 'Logo' });
    expect(nodes.get('drawn')).toMatchObject({ role: 'image', name: 'Chart' });
    expect(nodes.get('vector')).toMatchObject({ role: 'image', name: 'Icon' });
    // An empty alt marks decoration: the element is not an image and, with nothing else to say, not a node.
    const { tree } = await capture();
    expect(flatten(tree).filter((node) => node.role === 'image').map((node) => node.name)).toEqual(['Logo', 'Chart', 'Icon']);
    expect(flatten(tree).some((node) => node.role === 'presentation')).toBe(false);
  });

  it('passes the composite widget roles through from role attributes and names their items from content', async () => {
    await page.setContent(`
      <div role="tablist" aria-label="Filter" data-testid="tablist">
        <button role="tab" aria-selected="true" data-testid="tab">All</button>
      </div>
      <div role="tabpanel" aria-label="All items" data-testid="tabpanel"></div>
      <div role="toolbar" aria-label="Formatting" data-testid="toolbar">
        <button aria-pressed="true">Bold</button>
      </div>
      <div role="menubar" data-testid="menubar">
        <div role="menuitem" data-testid="menuitem">File</div>
      </div>
      <div role="menu" aria-label="View" data-testid="menu">
        <div role="menuitemcheckbox" aria-checked="true" data-testid="check">Show grid</div>
        <div role="menuitemradio" aria-checked="false" data-testid="radio">Compact</div>
      </div>
      <div role="tree" aria-label="Files" data-testid="tree">
        <div role="treeitem" aria-expanded="false" data-testid="treeitem">src</div>
      </div>
      <div role="grid" aria-label="Sheet" data-testid="grid">
        <div role="rowgroup" data-testid="rowgroup">
          <div role="row" data-testid="row">
            <div role="rowheader" data-testid="rowheader">1</div>
            <div role="gridcell" data-testid="gridcell">A1</div>
          </div>
        </div>
      </div>
      <div role="radiogroup" aria-label="Plan" data-testid="radiogroup"></div>
      <div role="tooltip" data-testid="tooltip">Saves the draft</div>
      <div role="separator" data-testid="separator"></div>
      <div role="progressbar" aria-label="Upload" aria-valuenow="40" data-testid="progressbar"></div>
      <div role="spinbutton" aria-label="Quantity" aria-valuenow="2" data-testid="spinbutton"></div>
      <div role="meter" aria-label="Disk" aria-valuenow="50" data-testid="meter"></div>
    `);
    const nodes = await rolesByTestId();
    const roles = Object.fromEntries([...nodes].map(([testId, node]) => [testId, node.role]));
    expect(roles).toEqual({
      tablist: 'tablist',
      tab: 'tab',
      tabpanel: 'tabpanel',
      toolbar: 'toolbar',
      menubar: 'menubar',
      menuitem: 'menuitem',
      menu: 'menu',
      check: 'menuitemcheckbox',
      radio: 'menuitemradio',
      tree: 'tree',
      treeitem: 'treeitem',
      grid: 'grid',
      rowgroup: 'rowgroup',
      row: 'row',
      rowheader: 'rowheader',
      gridcell: 'gridcell',
      radiogroup: 'radiogroup',
      tooltip: 'tooltip',
      separator: 'separator',
      progressbar: 'progressbar',
      spinbutton: 'spinbutton',
      meter: 'meter',
    });
    expect(nodes.get('check')).toMatchObject({ name: 'Show grid', states: { checked: true } });
    expect(nodes.get('radio')).toMatchObject({ name: 'Compact', states: { checked: false } });
    expect(nodes.get('treeitem')).toMatchObject({ name: 'src', states: { expanded: false } });
    expect(nodes.get('tooltip')?.name).toBe('Saves the draft');
  });

  it('derives the vocabulary roles from HTML semantics the way HTML-AAM does', async () => {
    await page.setContent(`
      <header data-testid="page-header">Site</header>
      <nav data-testid="nav"></nav>
      <main data-testid="main">
        <article data-testid="article"><header data-testid="article-header">Post</header></article>
        <section aria-label="Pricing" data-testid="named-section"></section>
        <section data-testid="plain-section">Unnamed</section>
        <form aria-label="Sign in" data-testid="named-form"><input aria-label="User"></form>
        <form data-testid="plain-form"><input aria-label="Query"></form>
        <fieldset data-testid="fieldset"><legend>Notifications</legend></fieldset>
        <details data-testid="details"><summary>More</summary>Body</details>
        <figure data-testid="figure"><figcaption>Figure one</figcaption></figure>
        <hr data-testid="rule">
        <menu data-testid="menu"><li data-testid="menu-item">Cut</li></menu>
        <progress value="3" max="10" aria-label="Upload" data-testid="progress"></progress>
        <meter value="0.5" aria-label="Disk" data-testid="meter"></meter>
        <input type="number" aria-label="Quantity" value="2" data-testid="number">
        <table data-testid="table">
          <thead data-testid="thead"><tr><th data-testid="col">Name</th></tr></thead>
          <tbody data-testid="tbody"><tr><th scope="row" data-testid="rowhead">Ada</th><td data-testid="cell">1</td></tr></tbody>
        </table>
        <address data-testid="address">Somewhere</address>
      </main>
      <aside data-testid="aside">Related</aside>
      <footer data-testid="page-footer">Legal</footer>
    `);
    const nodes = await rolesByTestId();
    const roles = Object.fromEntries([...nodes].map(([testId, node]) => [testId, node.role]));
    expect(roles).toEqual({
      'page-header': 'banner',
      nav: 'navigation',
      main: 'main',
      article: 'article',
      'article-header': undefined,
      'named-section': 'region',
      'plain-section': undefined,
      'named-form': 'form',
      'plain-form': undefined,
      fieldset: 'group',
      details: 'group',
      figure: 'figure',
      rule: 'separator',
      menu: 'list',
      'menu-item': 'listitem',
      progress: 'progressbar',
      meter: 'meter',
      number: 'spinbutton',
      table: 'table',
      thead: 'rowgroup',
      col: 'columnheader',
      tbody: 'rowgroup',
      rowhead: 'rowheader',
      cell: 'cell',
      address: 'group',
      aside: 'complementary',
      'page-footer': 'contentinfo',
    });
    expect(nodes.get('number')).toMatchObject({ name: 'Quantity', value: '2' });
    expect(nodes.get('progress')?.name).toBe('Upload');
  });
});
