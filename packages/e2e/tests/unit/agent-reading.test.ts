/** The rules `scroll_to` pages by: which node reads a text, within which list, and what counts as the screen moving. */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import type { RedactedNode } from '../../src/agent/observation.ts';
import { nodeReading, normalizeReading, pageLanded, pageMoved, readPage } from '../../src/agent/reading.ts';
import { redacted } from '../helpers/redacted.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

/** The observation's node index over a tree, depth first, as the feed builds it. */
function indexOf(...roots: SemanticNode[]): { nodes: Map<string, RedactedNode> } {
  const nodes = new Map<string, RedactedNode>();
  const walk = (entry: RedactedNode) => {
    nodes.set(entry.ref.id, entry);
    for (const child of entry.children ?? []) walk(child);
  };
  for (const root of roots) walk(redacted(root));
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

describe('readPage', () => {
  it('changes when a row keeps its name and its place but its text moves on', () => {
    const rect = { x: 0, y: 100, width: 300, height: 40 };
    const before = indexOf(node('r', { role: 'listitem', name: 'Product', text: 'Product 1', rect }));
    const after = indexOf(node('r', { role: 'listitem', name: 'Product', text: 'Product 2', rect }));
    const same = indexOf(node('r', { role: 'listitem', name: 'Product', text: 'Product 1', rect }));
    expect(pageMoved(readPage(before), readPage(after))).toBe(true);
    expect(pageMoved(readPage(before), readPage(same))).toBe(false);
    expect(readPage(indexOf(node('box', { role: 'group', rect }))).lines).toEqual([]);
  });
});

describe('a clock on the screen', () => {
  const clock = (time: string) => node('clock', { role: 'status', name: 'Clock', text: time, rect: { x: 0, y: 0, width: 100, height: 20 } });
  const row = (text: string) => node('r', { role: 'listitem', text, rect: { x: 0, y: 40, width: 300, height: 40 } });

  it('is not a page that moved, however it ticked', () => {
    const before = readPage(indexOf(clock('12:05'), row('Row 1')));
    for (const time of ['12:06', '9:59:59']) {
      const after = readPage(indexOf(clock(time), row('Row 1')));
      expect(pageMoved(before, after)).toBe(false);
      expect(pageLanded(before, after)).toBe(false);
    }
  });

  it('still lets a page that moved read differently', () => {
    const before = readPage(indexOf(clock('12:05'), row('Row 1')));
    const after = readPage(indexOf(clock('12:06'), row('Row 2')));
    expect(pageMoved(before, after)).toBe(true);
    expect(pageLanded(before, after)).toBe(true);
  });
});

describe('rows that differ by a clock-like value alone', () => {
  const slots = (...times: string[]) =>
    readPage(indexOf(...times.map((text, at) => node(`s${String(at)}`, { role: 'listitem', text, rect: { x: 0, y: at * 40, width: 300, height: 40 } }))));
  const header = node('h', { role: 'heading', name: 'Pick a time', rect: { x: 0, y: 0, width: 300, height: 40 } });
  const slot = (id: string, text: string, at: number) => node(id, { role: 'listitem', text, rect: { x: 0, y: 40 + at * 40, width: 300, height: 40 } });

  it('is a page that moved, a time picker turning over', () => {
    expect(pageMoved(slots('9:00 AM', '9:30 AM', '10:00 AM'), slots('10:30 AM', '11:00 AM', '11:30 AM'))).toBe(true);
    expect(pageMoved(readPage(indexOf(header, slot('a', '9:00', 0), slot('b', '9:30', 1))), readPage(indexOf(header, slot('a', '10:00', 0), slot('b', '10:30', 1))))).toBe(true);
  });

  it('is not one a swipe has landed on, since a clock beside the stale screen reads the same', () => {
    expect(pageLanded(slots('9:00 AM', '9:30 AM', '10:00 AM'), slots('10:30 AM', '11:00 AM', '11:30 AM'))).toBe(false);
  });

  it('is the same page when none changed, and not one when a single value changed', () => {
    expect(pageMoved(slots('9:00 AM', '9:30 AM'), slots('9:00 AM', '9:30 AM'))).toBe(false);
    expect(pageMoved(slots('9:00 AM', '9:30 AM'), slots('9:00 AM', '9:31 AM'))).toBe(false);
  });
});

describe('pageLanded', () => {
  const rows = (...texts: string[]) => readPage(indexOf(...texts.map((text, at) => node(`r${String(at)}`, { role: 'listitem', text, rect: { x: 0, y: at * 40, width: 300, height: 40 } }))));

  it('accepts a page that reads differently and is no sparser', () => {
    expect(pageLanded(rows('Row 1', 'Row 2', 'Row 3'), rows('Row 4', 'Row 5', 'Row 6'))).toBe(true);
    expect(pageLanded(rows('Row 1', 'Row 2'), rows('Row 3', 'Row 4', 'Row 5'))).toBe(true);
  });

  it('declines a page that reads the same, as the scroll not rendered yet or the end of the list', () => {
    expect(pageLanded(rows('Row 1', 'Row 2'), rows('Row 1', 'Row 2'))).toBe(false);
  });

  it('declines a thinner page, a windowed list between the scroll and the rows it draws', () => {
    expect(pageLanded(rows('Row 1', 'Row 2', 'Row 3'), rows('Row 4'))).toBe(false);
    expect(pageLanded(rows('Row 1', 'Row 2', 'Row 3'), rows())).toBe(false);
  });
});
