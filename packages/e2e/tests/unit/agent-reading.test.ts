/** The rules `scroll_to` pages by: which node reads a text, within which list, and what counts as the screen moving. */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { nodeReading, normalizeReading, readingShape } from '../../src/agent/reading.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

/** The observation's node index over a tree, depth first, as the feed builds it. */
function indexOf(...roots: SemanticNode[]): { nodes: Map<string, SemanticNode> } {
  const nodes = new Map<string, SemanticNode>();
  const walk = (entry: SemanticNode) => {
    nodes.set(entry.ref.id, entry);
    for (const child of entry.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return { nodes };
}

describe('nodeReading', () => {
  it('reads a whole label, or the text bounded by nothing of a word, never a longer number sharing its prefix', () => {
    const needle = normalizeReading('Row 12');
    expect(nodeReading(indexOf(node('a', { role: 'listitem', text: 'Row 120' })), needle)).toBeUndefined();
    expect(nodeReading(indexOf(node('a', { role: 'listitem', text: 'Row 120' }), node('b', { role: 'listitem', text: 'Row 12 - Golden' })), needle)?.ref.id).toBe('b');
    expect(nodeReading(indexOf(node('a', { role: 'listitem', text: 'Row 12 - Golden' }), node('b', { role: 'listitem', text: 'Row 12' })), needle)?.ref.id).toBe('b');
    expect(nodeReading(indexOf(node('a', { role: 'listitem', text: 'row  12' })), needle)?.ref.id).toBe('a');
  });

  it('skips a sentence that mentions the text and a hidden node', () => {
    const needle = normalizeReading('Row 0512');
    expect(nodeReading(indexOf(node('hint', { text: 'Scroll to Row 0512 and tap it, the list has 600 rows' })), needle)).toBeUndefined();
    expect(nodeReading(indexOf(node('gone', { text: 'Row 0512', states: { hidden: true } })), needle)).toBeUndefined();
  });

  it('reads only inside the list it is given, and the whole screen without one', () => {
    const jump = node('jump', { role: 'button', name: 'Jump to Row 333' });
    const list = node('list', {
      role: 'list',
      name: 'Ledger',
      children: [node('r1', { role: 'listitem', text: 'Row 1' }), node('r2', { role: 'listitem', text: 'Row 2' })],
    });
    const needle = normalizeReading('Row 333');
    expect(nodeReading(indexOf(jump, list), needle, list)).toBeUndefined();
    expect(nodeReading(indexOf(jump, list), needle)?.ref.id).toBe('jump');
    const rendered = node('list', { ...list, children: [...list.children!, node('r333', { role: 'listitem', text: 'Row 333' })] });
    expect(nodeReading(indexOf(jump, rendered), needle, rendered)?.ref.id).toBe('r333');
  });
});

describe('readingShape', () => {
  it('changes when a row keeps its name and its place but its text moves on', () => {
    const rect = { x: 0, y: 100, width: 300, height: 40 };
    const before = indexOf(node('r', { role: 'listitem', name: 'Product', text: 'Product 1', rect }));
    const after = indexOf(node('r', { role: 'listitem', name: 'Product', text: 'Product 2', rect }));
    const same = indexOf(node('r', { role: 'listitem', name: 'Product', text: 'Product 1', rect }));
    expect(readingShape(before)).not.toBe(readingShape(after));
    expect(readingShape(before)).toBe(readingShape(same));
    expect(readingShape(indexOf(node('box', { role: 'group', rect })))).toBe('');
  });
});
