/** The real reader reports the text selected inside the focused field, and only there. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { byTestId, startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession();
});

afterAll(async () => {
  await page.close();
});

/** One observation of the page, keyed by test id. */
async function captureByTestId(): Promise<Map<string | undefined, SemanticNode>> {
  return new Map((await page.nodes()).map((node) => [node.testId, node]));
}

/** Focuses the field with `testId` and selects `[start, end)` of its value, or all of it. */
async function select(testId: string, range?: readonly [number, number]): Promise<void> {
  await page.act(byTestId(testId), { kind: 'focus' });
  await page.browser.evaluate(({ id, range: bounds }: { id: string; range: number[] | null }) => {
    const field = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
    if (bounds === null) field.select();
    else field.setSelectionRange(bounds[0]!, bounds[1]!);
    return null;
  }, { id: testId, range: range === undefined ? null : [...range] });
}

describe('selection', () => {
  it('reports the selected text of the focused input or editing host and nothing for a caret, an unfocused field, or a secure one', async () => {
    await page.setContent(`
      <input data-testid="field" value="release approved">
      <textarea data-testid="note">first line</textarea>
      <div data-testid="editor" contenteditable>release approved</div>
      <input type="password" data-testid="secret" value="hunter2">
    `);

    await select('field', [8, 16]);
    let nodes = await captureByTestId();
    expect(nodes.get('field')).toMatchObject({ value: 'release approved', selection: 'approved', states: { focused: true } });
    expect(nodes.get('note')?.selection).toBeUndefined();
    expect(nodes.get('editor')?.selection).toBeUndefined();

    await select('note', [6, 10]);
    nodes = await captureByTestId();
    expect(nodes.get('note')?.selection).toBe('line');
    // The input keeps its range while unfocused; only the focused field reports one.
    expect(nodes.get('field')?.selection).toBeUndefined();

    await page.act(byTestId('editor'), { kind: 'tap' });
    await page.browser.keyboard.press('End');
    nodes = await captureByTestId();
    expect(nodes.get('editor')).toMatchObject({ role: 'textbox', value: 'release approved', states: { focused: true } });
    expect(nodes.get('editor')?.selection).toBeUndefined();

    for (let index = 0; index < 'approved'.length; index += 1) await page.browser.keyboard.press('Shift+ArrowLeft');
    nodes = await captureByTestId();
    expect(nodes.get('editor')?.selection).toBe('approved');

    await select('secret');
    nodes = await captureByTestId();
    expect(nodes.get('secret')?.states?.secure).toBe(true);
    expect(nodes.get('secret')?.value).toBeUndefined();
    expect(nodes.get('secret')?.selection).toBeUndefined();
  });
});
