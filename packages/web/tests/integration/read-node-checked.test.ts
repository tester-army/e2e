/** The real reader takes a native control's checked and selected state from the control, and aria-* only where there is none. */

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

/** One observation of the page through the same capture the engine uses, keyed by test id. */
async function captureByTestId(): Promise<Map<string | undefined, SemanticNode>> {
  let nextId = 1;
  const published = new Map<string, ElementHandle<Element>>();
  const { tree } = await captureDocument(
    {
      testIdAttribute: 'data-testid',
      site: undefined,
      reserveIds: (count) => { const first = nextId; nextId += count; return first; },
      commit: (id, element) => { published.set(id, element); },
    },
    page,
    { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal },
  );
  await Promise.all([...published.values()].map((element) => element.dispose()));
  const nodes: SemanticNode[] = [];
  const walk = (node: SemanticNode) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
  walk(tree);
  return new Map(nodes.map((node) => [node.testId, node]));
}

describe('checked and selected', () => {
  it('reads a native checkbox, radio, and option from the control even when a stale aria attribute disagrees, as Playwright does', async () => {
    await page.setContent(`
      <input type="checkbox" data-testid="stale-off" aria-checked="false" checked aria-label="Stale off">
      <input type="checkbox" data-testid="stale-on" aria-checked="true" aria-label="Stale on">
      <input type="radio" name="r" data-testid="radio-stale-off" aria-checked="false" checked aria-label="Radio stale off">
      <input type="radio" name="r2" data-testid="radio-stale-on" aria-checked="true" aria-label="Radio stale on">
      <input type="checkbox" data-testid="plain-on" checked aria-label="Plain on">
      <input type="checkbox" data-testid="plain-off" aria-label="Plain off">
      <div role="checkbox" aria-checked="true" data-testid="aria-on" tabindex="0">Aria on</div>
      <div role="switch" aria-checked="false" data-testid="aria-off" tabindex="0">Aria off</div>
      <select data-testid="select" aria-label="Plan" size="3">
        <option data-testid="option-stale-off" aria-selected="false" selected>Team</option>
        <option data-testid="option-stale-on" aria-selected="true">Solo</option>
      </select>
      <div role="tablist"><button role="tab" aria-selected="true" data-testid="tab">All</button></div>
    `);
    const nodes = await captureByTestId();
    const checked = (testId: string) => nodes.get(testId)?.states?.checked;
    const selected = (testId: string) => nodes.get(testId)?.states?.selected;

    expect(checked('stale-off')).toBe(true);
    expect(checked('stale-on')).toBe(false);
    expect(checked('radio-stale-off')).toBe(true);
    expect(checked('radio-stale-on')).toBe(false);
    expect(checked('plain-on')).toBe(true);
    expect(checked('plain-off')).toBe(false);
    expect(checked('aria-on')).toBe(true);
    expect(checked('aria-off')).toBe(false);
    expect(selected('option-stale-off')).toBe(true);
    expect(selected('option-stale-on')).toBe(false);
    expect(selected('tab')).toBe(true);

    for (const testId of ['stale-off', 'stale-on', 'radio-stale-off', 'radio-stale-on', 'plain-on', 'plain-off', 'aria-on', 'aria-off']) {
      expect(await page.getByTestId(testId).isChecked(), testId).toBe(checked(testId));
    }
  });
});
