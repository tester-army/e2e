/** The real reader reports the text selected inside the focused field, and only there. */

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

describe('selection', () => {
  it('reports the selected text of the focused input or editing host and nothing for a caret, an unfocused field, or a secure one', async () => {
    await page.setContent(`
      <input data-testid="field" value="release approved">
      <textarea data-testid="note">first line</textarea>
      <div data-testid="editor" contenteditable>release approved</div>
      <input type="password" data-testid="secret" value="hunter2">
    `);

    await page.getByTestId('field').focus();
    await page.getByTestId('field').evaluate((el: HTMLInputElement) => el.setSelectionRange(8, 16));
    let nodes = await captureByTestId();
    expect(nodes.get('field')).toMatchObject({ value: 'release approved', selection: 'approved', states: { focused: true } });
    expect(nodes.get('note')?.selection).toBeUndefined();
    expect(nodes.get('editor')?.selection).toBeUndefined();

    await page.getByTestId('note').focus();
    await page.getByTestId('note').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 10));
    nodes = await captureByTestId();
    expect(nodes.get('note')?.selection).toBe('line');
    // The input keeps its range while unfocused; only the focused field reports one.
    expect(nodes.get('field')?.selection).toBeUndefined();

    await page.getByTestId('editor').click();
    await page.keyboard.press('End');
    nodes = await captureByTestId();
    expect(nodes.get('editor')).toMatchObject({ role: 'textbox', value: 'release approved', states: { focused: true } });
    expect(nodes.get('editor')?.selection).toBeUndefined();

    for (let index = 0; index < 'approved'.length; index += 1) await page.keyboard.press('Shift+ArrowLeft');
    nodes = await captureByTestId();
    expect(nodes.get('editor')?.selection).toBe('approved');

    await page.getByTestId('secret').focus();
    await page.getByTestId('secret').evaluate((el: HTMLInputElement) => el.select());
    nodes = await captureByTestId();
    expect(nodes.get('secret')?.states?.secure).toBe(true);
    expect(nodes.get('secret')?.value).toBeUndefined();
    expect(nodes.get('secret')?.selection).toBeUndefined();
  });
});
