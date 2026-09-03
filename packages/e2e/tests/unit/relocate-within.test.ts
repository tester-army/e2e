import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/backend/surface.ts';
import { containerKey, describeAction } from '../../src/agent/actions.ts';
import { relocateDescriptor } from '../../src/cache/relocate.ts';

const identity = (text: string): string => text;

/** A two-row table: identical "Delete" buttons told apart only by their row. */
function table(): { nodes: Map<string, SemanticNode>; parents: Map<string, string> } {
  const nodes = new Map<string, SemanticNode>();
  const parents = new Map<string, string>();
  const add = (id: string, node: Omit<SemanticNode, 'ref'>, parent?: string): SemanticNode => {
    const full: SemanticNode = { ref: { id, revision: 'r' }, ...node };
    nodes.set(id, full);
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
    expect(containerKey('d1', nodes, parents, identity)).toBe('Budget draft');
    expect(containerKey('d2', nodes, parents, identity)).toBe('Vendor list');
    // The cell itself is the row's key: nothing to add.
    expect(containerKey('c1', nodes, parents, identity)).toBeUndefined();
  });

  it('records the key with the action and reads it back in the prose', () => {
    const { nodes } = table();
    const described = describeAction({ name: 'tap', node: nodes.get('d1')!, within: 'Budget draft' }, identity, 'data-testid');
    expect(described.target?.within).toBe('Budget draft');
    expect(described.summary).toBe('tap button "Delete" in "Budget draft"');
  });

  it('relocates a same-named control by its row instead of diverging as ambiguous', () => {
    const { nodes, parents } = table();
    const options = { redact: identity, testIdAttribute: 'data-testid', parents };
    expect(relocateDescriptor({ role: 'button', name: 'Delete', within: 'Vendor list' }, nodes, options)).toEqual({ kind: 'found', id: 'd2' });
    expect(relocateDescriptor({ role: 'button', name: 'Delete' }, nodes, options)).toEqual({ kind: 'failed', failure: 'target-ambiguous' });
    // The row is gone: not found, never the other row's button.
    expect(relocateDescriptor({ role: 'button', name: 'Delete', within: 'Offsite plan' }, nodes, options)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });
});
