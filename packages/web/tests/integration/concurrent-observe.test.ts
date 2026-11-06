/** Two observations at once take turns: neither supersedes the other's capture mid-flight. */

import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { startWebSession } from '../helpers/web-session.ts';

/** Every node of a tree, including nested documents. */
function nodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

it('captures both of two concurrent observations, and the refs of the last stay actionable', async () => {
  const page = await startWebSession();
  try {
    await page.setContent('<button onclick="document.body.dataset.clicked = \'yes\'">Press</button>');
    const [first, second] = await Promise.all([page.observe({ pixels: true }), page.observe({ pixels: true })]);
    expect(first.pixels).toBeDefined();
    expect(second.pixels).toBeDefined();
    const button = nodes(second.root).find((node) => node.role === 'button');
    expect(button).toBeDefined();
    await page.engine.perform!(button!.ref, { kind: 'tap' }, page.op(5_000));
    expect(await page.browser.evaluate(() => document.body.dataset.clicked ?? null)).toBe('yes');
  } finally {
    await page.close();
  }
});
