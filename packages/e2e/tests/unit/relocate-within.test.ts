import { describe, expect, it } from 'vitest';
import type { RedactedNode } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { redacted } from '../helpers/redacted.ts';
import { containerKey, describeAction } from '../../src/agent/actions.ts';
import { describePosition, relocateExact } from '../../src/cache/locate.ts';

const identity = (text: string): string => text;

function fixture(id: string, fields: Omit<SemanticNode, 'ref'>): SemanticNode {
  return { ref: { id, revision: 'r' }, ...fields };
}

/** A two-row table: identical "Delete" buttons told apart only by their row. */
function table(): { nodes: Map<string, RedactedNode>; parents: Map<string, string> } {
  const nodes = new Map<string, RedactedNode>();
  const parents = new Map<string, string>();
  const add = (id: string, node: Omit<SemanticNode, 'ref'>, parent?: string): SemanticNode => {
    const full: SemanticNode = { ref: { id, revision: 'r' }, ...node };
    nodes.set(id, redacted(full));
    if (parent !== undefined) parents.set(id, parent);
    return full;
  };
  const c1 = add('c1', { role: 'cell', text: 'Budget draft' }, 'r1');
  const d1 = add('d1', { role: 'button', name: 'Delete' }, 'r1');
  add('r1', { role: 'row', children: [c1, d1] }, 't');
  const c2 = add('c2', { role: 'cell', text: 'Vendor list' }, 'r2');
  const d2 = add('d2', { role: 'button', name: 'Delete' }, 'r2');
  add('r2', { role: 'row', children: [c2, d2] }, 't');
  add('t', { role: 'table', name: 'Documents' });
  return { nodes, parents };
}

describe('container keys', () => {
  it('never keys a row of a list by the list\'s first row, a neighbour a scroll changes', () => {
    const nodes = new Map<string, RedactedNode>();
    const parents = new Map<string, string>();
    const rows = [499, 500, 512].map((n) => {
      const label = fixture(`t${n}`, { role: 'text', text: `Row 0${n}` });
      const row = fixture(`r${n}`, { role: 'group', name: `Row 0${n}`, testId: `row-${n}`, children: [label] });
      nodes.set(row.ref.id, redacted(row));
      nodes.set(label.ref.id, redacted(label));
      parents.set(label.ref.id, row.ref.id);
      parents.set(row.ref.id, 'list');
      return row;
    });
    nodes.set('list', redacted(fixture('list', { role: 'group', children: rows })));
    expect(containerKey('r512', nodes, parents)).toBeUndefined();
  });

  it('names the row a control sits in by the row\'s first text', () => {
    const { nodes, parents } = table();
    expect(containerKey('d1', nodes, parents)).toBe('Budget draft');
    expect(containerKey('d2', nodes, parents)).toBe('Vendor list');
    // The cell itself is the row's key: nothing to add.
    expect(containerKey('c1', nodes, parents)).toBeUndefined();
  });

  it('records the key with the action and reads it back in the prose', () => {
    const { nodes } = table();
    const described = describeAction({ name: 'tap', node: nodes.get('d1')!, within: 'Budget draft' }, { redact: identity, redactCut: identity });
    expect(described.target?.within).toBe('Budget draft');
    expect(described.summary).toBe('tap button "Delete" in "Budget draft"');
  });

  it('relocates a same-named control by its row instead of diverging as ambiguous', () => {
    const { nodes, parents } = table();
    void parents;
    expect(relocateExact({ role: 'button', name: 'Delete', within: 'Vendor list' }, nodes)).toEqual({ kind: 'found', id: 'd2' });
    expect(relocateExact({ role: 'button', name: 'Delete' }, nodes)).toMatchObject({ kind: 'failed', failure: 'target-ambiguous' });
    // The row is gone: not found, never the other row's button.
    expect(relocateExact({ role: 'button', name: 'Delete', within: 'Offsite plan' }, nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('keys an icon button by its row\'s own label when the row has no other text, and finds it after the rows reorder', () => {
    // `<li>Alpha <button><svg/></button></li>`: the list item is named from its content, the button by nothing.
    const list = (order: readonly string[]) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      for (const label of order) {
        const button: SemanticNode = { ref: { id: `b-${label}`, revision: 'r' }, role: 'button' };
        nodes.set(`li-${label}`, redacted({ ref: { id: `li-${label}`, revision: 'r' }, role: 'listitem', name: label, children: [button] }));
        nodes.set(button.ref.id, redacted(button));
        parents.set(button.ref.id, `li-${label}`);
      }
      return { nodes, parents };
    };
    const recorded = list(['Alpha', 'Beta']);
    const within = containerKey('b-Alpha', recorded.nodes, recorded.parents);
    expect(within).toBe('Alpha');
    const position = describePosition(recorded.nodes.get('b-Alpha')!, within, recorded.nodes);
    expect(position).toEqual({ index: 0, of: 1 });
    const live = list(['Beta', 'Alpha']);
    expect(relocateExact({ role: 'button', within: within!, position: position! }, live.nodes)).toEqual({ kind: 'found', id: 'b-Alpha' });
  });

  it('keys a control by its nearest container only, so rows with no text of their own share no outer label', () => {
    const nodes = new Map<string, RedactedNode>();
    const parents = new Map<string, string>();
    const button: SemanticNode = { ref: { id: 'b', revision: 'r' }, role: 'button' };
    const group: SemanticNode = { ref: { id: 'g', revision: 'r' }, role: 'group', children: [button] };
    const title: SemanticNode = { ref: { id: 't', revision: 'r' }, text: 'Shipping address' };
    nodes.set('r', redacted({ ref: { id: 'r', revision: 'r' }, role: 'region', children: [title, group] }));
    for (const node of [title, group, button]) nodes.set(node.ref.id, redacted(node));
    parents.set('b', 'g');
    parents.set('g', 'r');
    parents.set('t', 'r');
    expect(containerKey('b', nodes, parents)).toBeUndefined();

    // A row whose first text is the link itself names it already: the list around it says nothing more.
    const link: SemanticNode = { ref: { id: 'l', revision: 'r' }, role: 'link', name: 'Beta' };
    nodes.set('l', redacted(link));
    nodes.set('li', redacted({ ref: { id: 'li', revision: 'r' }, role: 'listitem', name: 'Beta', children: [link] }));
    parents.set('l', 'li');
    parents.set('li', 'r');
    expect(containerKey('l', nodes, parents)).toBeUndefined();
  });
});
