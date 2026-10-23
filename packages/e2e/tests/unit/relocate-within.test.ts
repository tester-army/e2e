import { describe, expect, it } from 'vitest';
import type { RedactedNode } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { redacted } from '../helpers/redacted.ts';
import { containerKey, describeAction } from '../../src/agent/actions.ts';
import { describePlacement, describePosition, relocateDescriptor } from '../../src/cache/relocate.ts';

const identity = (text: string): string => text;

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
  it('names the row a control sits in by the row\'s first text', () => {
    const { nodes, parents } = table();
    expect(containerKey('d1', nodes, parents)).toBe('Budget draft');
    expect(containerKey('d2', nodes, parents)).toBe('Vendor list');
    // The cell itself is the row's key: nothing to add.
    expect(containerKey('c1', nodes, parents)).toBeUndefined();
  });

  it('never keys a container by a live value, so its control replays at another count', () => {
    // `<section aria-label="Counter"><p>Count: <output>N</output></p><button>Increment</button></section>`
    const counter = (role: string, reading: string) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      const count: SemanticNode = { ref: { id: 'o', revision: 'r' }, role, name: reading, text: reading };
      const line: SemanticNode = { ref: { id: 'p', revision: 'r' }, text: `Count: ${reading}`, children: [count] };
      const button: SemanticNode = { ref: { id: 'b', revision: 'r' }, role: 'button', name: 'Increment' };
      nodes.set('s', redacted({ ref: { id: 's', revision: 'r' }, role: 'region', name: 'Counter', children: [line, button] }));
      for (const node of [count, line, button]) nodes.set(node.ref.id, redacted(node));
      parents.set('o', 'p');
      parents.set('p', 's');
      parents.set('b', 's');
      return { nodes, parents };
    };
    for (const role of ['status', 'timer', 'marquee', 'log', 'progressbar', 'meter']) {
      const recorded = counter(role, '0');
      expect(describePlacement(recorded.nodes.get('b')!, recorded.nodes, recorded.parents)).toEqual({});
      expect(relocateDescriptor({ role: 'button', name: 'Increment' }, counter(role, '7').nodes)).toEqual({ kind: 'found', id: 'b' });
    }
  });

  it('keys twins that only a live value tells apart by that value, so a reorder finds the right one and a count no row reads misses', () => {
    // `<li><p>Qty: <output>N</output></p><button>Remove</button></li>`: nothing but the count differs between rows.
    const rows = (counts: readonly string[]) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      for (const count of counts) {
        const value: SemanticNode = { ref: { id: `o-${count}`, revision: 'r' }, role: 'status', name: count, text: count };
        const line: SemanticNode = { ref: { id: `p-${count}`, revision: 'r' }, text: `Qty: ${count}`, children: [value] };
        const button: SemanticNode = { ref: { id: `b-${count}`, revision: 'r' }, role: 'button', name: 'Remove', text: 'Remove' };
        nodes.set(`li-${count}`, redacted({ ref: { id: `li-${count}`, revision: 'r' }, role: 'listitem', children: [line, button] }));
        for (const node of [value, line, button]) nodes.set(node.ref.id, redacted(node));
        parents.set(`o-${count}`, `p-${count}`);
        parents.set(`p-${count}`, `li-${count}`);
        parents.set(`b-${count}`, `li-${count}`);
      }
      return { nodes, parents };
    };
    const recorded = rows(['2', '5']);
    const placement = describePlacement(recorded.nodes.get('b-5')!, recorded.nodes, recorded.parents);
    expect(placement).toEqual({ within: '5' });
    const descriptor = { role: 'button', name: 'Remove', ...placement };
    expect(relocateDescriptor(descriptor, rows(['5', '2']).nodes)).toEqual({ kind: 'found', id: 'b-5' });
    expect(relocateDescriptor(descriptor, rows(['2', '6']).nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('keys nothing by a container whose only text is a live value, not even its label that carries the value', () => {
    // `<li>Pears <output>N</output> <button aria-label="Remove"><svg/></button></li>`: the list item is named from its content.
    const rows = (counts: readonly (readonly [string, string])[]) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      for (const [item, count] of counts) {
        const value: SemanticNode = { ref: { id: `o-${item}`, revision: 'r' }, role: 'status', name: count, text: count };
        const icon: SemanticNode = { ref: { id: `i-${item}`, revision: 'r' }, role: 'image' };
        const button: SemanticNode = { ref: { id: `b-${item}`, revision: 'r' }, role: 'button', name: 'Remove', text: '', children: [icon] };
        nodes.set(`li-${item}`, redacted({ ref: { id: `li-${item}`, revision: 'r' }, role: 'listitem', name: `${item} ${count} Remove`, text: `${item} ${count}`, children: [value, button] }));
        for (const node of [value, icon, button]) nodes.set(node.ref.id, redacted(node));
        parents.set(`o-${item}`, `li-${item}`);
        parents.set(`i-${item}`, `b-${item}`);
        parents.set(`b-${item}`, `li-${item}`);
      }
      return { nodes, parents };
    };
    const single = rows([['Pears', '5']]);
    expect(describePlacement(single.nodes.get('b-Pears')!, single.nodes, single.parents)).toEqual({});
    expect(relocateDescriptor({ role: 'button', name: 'Remove' }, rows([['Pears', '6']]).nodes)).toEqual({ kind: 'found', id: 'b-Pears' });
    // Twins with nothing else to tell them apart keep the value.
    const twins = rows([['Apples', '3'], ['Pears', '5']]);
    expect(describePlacement(twins.nodes.get('b-Pears')!, twins.nodes, twins.parents)).toEqual({ within: '5' });
  });

  it('places an anonymous control next to a live value as the one of its kind, not by the value', () => {
    // `<section aria-label="Counter"><output>N</output><button><svg/></button></section>`
    const counter = (reading: string) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      const count: SemanticNode = { ref: { id: 'o', revision: 'r' }, role: 'status', name: reading, text: reading };
      const button: SemanticNode = { ref: { id: 'b', revision: 'r' }, role: 'button' };
      nodes.set('s', redacted({ ref: { id: 's', revision: 'r' }, role: 'region', name: 'Counter', children: [count, button] }));
      for (const node of [count, button]) nodes.set(node.ref.id, redacted(node));
      parents.set('o', 's');
      parents.set('b', 's');
      return { nodes, parents };
    };
    const recorded = counter('0');
    const placement = describePlacement(recorded.nodes.get('b')!, recorded.nodes, recorded.parents);
    expect(placement).toEqual({ position: { index: 0, of: 1 } });
    expect(relocateDescriptor({ role: 'button', ...placement }, counter('7').nodes)).toEqual({ kind: 'found', id: 'b' });
  });

  it('keys a row by its first text past a live value, and finds it after the value and the order change', () => {
    // `<li><output>2</output> × <a href>Apples</a> <button>Remove</button></li>`
    const cart = (rows: readonly (readonly [string, string])[]) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      for (const [item, quantity] of rows) {
        const count: SemanticNode = { ref: { id: `q-${item}`, revision: 'r' }, role: 'status', name: quantity, text: quantity };
        const link: SemanticNode = { ref: { id: `l-${item}`, revision: 'r' }, role: 'link', name: item, text: item };
        const button: SemanticNode = { ref: { id: `b-${item}`, revision: 'r' }, role: 'button', name: 'Remove', text: 'Remove' };
        nodes.set(`li-${item}`, redacted({ ref: { id: `li-${item}`, revision: 'r' }, role: 'listitem', text: `${quantity} × ${item} Remove`, children: [count, link, button] }));
        for (const node of [count, link, button]) {
          nodes.set(node.ref.id, redacted(node));
          parents.set(node.ref.id, `li-${item}`);
        }
      }
      return { nodes, parents };
    };
    const recorded = cart([['Apples', '2'], ['Pears', '2']]);
    const placement = describePlacement(recorded.nodes.get('b-Pears')!, recorded.nodes, recorded.parents);
    expect(placement).toEqual({ within: 'Pears' });
    const live = cart([['Pears', '3'], ['Apples', '2']]);
    expect(relocateDescriptor({ role: 'button', name: 'Remove', ...placement }, live.nodes)).toEqual({ kind: 'found', id: 'b-Pears' });
  });

  it('keeps a row keyed by its first leaf when a shared label precedes it', () => {
    // `<li><p>Order <a href>#1042</a></p><button>Cancel</button></li>`: every row's line starts "Order".
    const orders = (ids: readonly string[]) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      for (const id of ids) {
        const link: SemanticNode = { ref: { id: `l-${id}`, revision: 'r' }, role: 'link', name: id, text: id };
        const line: SemanticNode = { ref: { id: `p-${id}`, revision: 'r' }, text: `Order ${id}`, children: [link] };
        const button: SemanticNode = { ref: { id: `b-${id}`, revision: 'r' }, role: 'button', name: 'Cancel', text: 'Cancel' };
        nodes.set(`li-${id}`, redacted({ ref: { id: `li-${id}`, revision: 'r' }, role: 'listitem', children: [line, button] }));
        for (const node of [link, line, button]) nodes.set(node.ref.id, redacted(node));
        parents.set(`l-${id}`, `p-${id}`);
        parents.set(`p-${id}`, `li-${id}`);
        parents.set(`b-${id}`, `li-${id}`);
      }
      return { nodes, parents };
    };
    const recorded = orders(['#1042', '#1043']);
    expect(containerKey('b-#1043', recorded.nodes, recorded.parents)).toBe('#1043');
    expect(relocateDescriptor({ role: 'button', name: 'Cancel', within: '#1043' }, orders(['#1043', '#1042']).nodes)).toEqual({ kind: 'found', id: 'b-#1043' });
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
    expect(relocateDescriptor({ role: 'button', name: 'Delete', within: 'Vendor list' }, nodes)).toEqual({ kind: 'found', id: 'd2' });
    expect(relocateDescriptor({ role: 'button', name: 'Delete' }, nodes)).toMatchObject({ kind: 'failed', failure: 'target-ambiguous' });
    // The row is gone: not found, never the other row's button.
    expect(relocateDescriptor({ role: 'button', name: 'Delete', within: 'Offsite plan' }, nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
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
    expect(relocateDescriptor({ role: 'button', within: within!, position: position! }, live.nodes)).toEqual({ kind: 'found', id: 'b-Alpha' });
  });

  it('does not key a row of a windowed list by whichever twin row is rendered first', () => {
    // An Android FlatList: an unnamed group of group rows, the rendered window moving with the scroll.
    const list = (first: number, header?: SemanticNode) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      const rows: SemanticNode[] = [];
      if (header !== undefined) {
        for (const node of [header, ...(header.children ?? [])]) nodes.set(node.ref.id, redacted(node));
        for (const child of header.children ?? []) parents.set(child.ref.id, header.ref.id);
        parents.set(header.ref.id, 'list');
        rows.push(header);
      }
      for (let n = first; n < first + 12; n += 1) {
        const label = `Row ${String(n).padStart(4, '0')}`;
        const text: SemanticNode = { ref: { id: `t-${String(n)}`, revision: 'r' }, role: 'text', text: label };
        const row: SemanticNode = { ref: { id: `row-${String(n)}`, revision: 'r' }, role: 'group', name: label, testId: `row-${String(n)}`, children: [text] };
        nodes.set(text.ref.id, redacted(text));
        nodes.set(row.ref.id, redacted(row));
        parents.set(text.ref.id, row.ref.id);
        parents.set(row.ref.id, 'list');
        rows.push(row);
      }
      nodes.set('list', redacted({ ref: { id: 'list', revision: 'r' }, role: 'group', children: rows }));
      return { nodes, parents };
    };
    const recorded = list(500);
    expect(containerKey('row-505', recorded.nodes, recorded.parents)).toBeUndefined();
    expect(containerKey('t-505', recorded.nodes, recorded.parents)).toBeUndefined();
    // A control inside a row is still keyed by its row.
    expect(containerKey('d1', table().nodes, table().parents)).toBe('Budget draft');
    const live = list(501);
    expect(relocateDescriptor({ role: 'group', name: 'Row 0512', testId: 'row-512' }, live.nodes)).toEqual({ kind: 'found', id: 'row-512' });
    // A live count above the rows is no first text, alone or in a line: the list is still named after its first row.
    const count: SemanticNode = { ref: { id: 'count', revision: 'r' }, role: 'status', name: '1,200', text: '1,200' };
    const counted = list(500, count);
    expect(containerKey('row-505', counted.nodes, counted.parents)).toBeUndefined();
    const line = list(500, { ref: { id: 'line', revision: 'r' }, text: 'Showing 1,200 results', children: [count] });
    expect(containerKey('row-505', line.nodes, line.parents)).toBeUndefined();
    // A named list still keys its rows by its own label, past the count.
    for (const named of [list(500), counted, line]) {
      named.nodes.set('list', { ...named.nodes.get('list')!, name: 'Results' });
      expect(containerKey('row-505', named.nodes, named.parents)).toBe('Results');
    }
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
