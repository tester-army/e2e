/** The real reader calls a node hidden by one predicate in both modes and says when aria-hidden is why. */

import { chromium, type Browser, type ElementHandle, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { captureDocument, toSemanticNode } from '../../src/observation.ts';
import { readManySemanticsFunction, SECURE_FIELD_SELECTOR, type RawNodeData } from '../../src/read-node.ts';

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

/** Test ids the walk included. */
async function walkedTestIds(): Promise<Set<string>> {
  const { tree } = await capture();
  return new Set(flatten(tree).map((node) => node.testId).filter((id): id is string => id !== undefined));
}

/** The single-node read `locate` makes of the one element carrying the test id. */
async function readOne(testId: string): Promise<RawNodeData> {
  const raws = await page.locator(`[data-testid="${testId}"]`).evaluateAll(readManySemanticsFunction, {
    testIdAttribute: 'data-testid',
    secureFieldSelector: SECURE_FIELD_SELECTOR,
    mode: { kind: 'node' as const },
  });
  expect(raws).toHaveLength(1);
  return raws[0]!;
}

describe('visibility', () => {
  it('reads a node under an aria-hidden ancestor as hidden by aria-hidden, and the walk leaves it out', async () => {
    await page.setContent(`
      <div aria-hidden="true"><p data-testid="following">Following</p></div>
      <div aria-hidden="true" id="host"></div>
      <p data-testid="shown">Shown</p>
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
          '<p data-testid="shadowed">Shadow text</p>';
      </script>
    `);
    expect(await readOne('following')).toMatchObject({ states: { hidden: true }, hiddenBy: 'aria-hidden' });
    expect(await readOne('shadowed')).toMatchObject({ states: { hidden: true }, hiddenBy: 'aria-hidden' });
    expect(await readOne('shown')).toMatchObject({ states: { hidden: false }, hiddenBy: null });
    const walked = await walkedTestIds();
    expect(walked.has('following')).toBe(false);
    expect(walked.has('shadowed')).toBe(false);
    expect(walked.has('shown')).toBe(true);
  });

  it('marks decorative text inside a named link hidden by aria-hidden, while the link is shown', async () => {
    await page.setContent(`
      <a href="/" aria-label="Good Ppl" data-testid="link"><span aria-hidden="true" data-testid="decoration">Good Ppl</span></a>
    `);
    const decoration = await readOne('decoration');
    expect(decoration).toMatchObject({ states: { hidden: true }, hiddenBy: 'aria-hidden' });
    expect(toSemanticNode({ id: 'n1', revision: '' }, decoration)).toMatchObject({
      states: { hidden: true },
      hiddenBy: 'aria-hidden',
    });
    expect(await readOne('link')).toMatchObject({ role: 'link', name: 'Good Ppl', states: { hidden: false }, hiddenBy: null });
    const { tree } = await capture();
    expect(flatten(tree).find((node) => node.role === 'link')).toMatchObject({ name: 'Good Ppl', testId: 'link' });
    expect((await walkedTestIds()).has('decoration')).toBe(false);
  });

  it('reads a layout-hidden node as hidden with no reason', async () => {
    await page.setContent(`
      <p data-testid="collapsed" style="display: none">Collapsed</p>
      <p data-testid="invisible" style="visibility: hidden">Invisible</p>
    `);
    for (const testId of ['collapsed', 'invisible']) {
      const raw = await readOne(testId);
      expect(raw, testId).toMatchObject({ states: { hidden: true }, hiddenBy: null });
      expect(toSemanticNode({ id: 'n1', revision: '' }, raw), testId).not.toHaveProperty('hiddenBy');
    }
    const walked = await walkedTestIds();
    expect(walked.has('collapsed')).toBe(false);
    expect(walked.has('invisible')).toBe(false);
  });
});
