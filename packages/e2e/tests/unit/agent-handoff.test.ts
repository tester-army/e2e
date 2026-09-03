import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/backend/surface.ts';
import { appearedText } from '../../src/agent/handoff.ts';
import type { AgentObservation } from '../../src/agent/observation.ts';

function observation(nodes: SemanticNode[]): AgentObservation {
  const map = new Map<string, SemanticNode>();
  const index = (node: SemanticNode): void => {
    map.set(node.ref.id, node);
    for (const child of node.children ?? []) index(child);
  };
  for (const node of nodes) index(node);
  return {
    revision: 'r',
    text: '',
    bytes: 0,
    nodes: map,
    parents: new Map(),
    viewport: { width: 1, height: 1, scale: 1 },
    truncated: false,
  };
}
const node = (id: string, fields: Partial<SemanticNode> = {}): SemanticNode => ({ ref: { id, revision: 'r' }, ...fields });
const identity = (text: string): string => text;

describe('appearedText', () => {
  it('quotes announcements first, then plain text, never controls or unchanged nodes', () => {
    const before = observation([node('n1', { role: 'document', name: 'Desk', children: [node('n2', { role: 'button', name: 'Issue ticket' })] })]);
    const after = observation([
      node('n1', {
        role: 'document',
        name: 'Desk',
        children: [
          node('n9', { text: 'Keep the details handy.' }),
          node('n5', { role: 'status', name: 'Ticket', text: 'Ticket TK-6830 · colour Amber · desk 8' }),
          node('n6', { role: 'link', name: 'Gate' }),
        ],
      }),
    ]);
    expect(appearedText(before, after, identity)).toEqual([
      'Ticket TK-6830 · colour Amber · desk 8',
      'Keep the details handy.',
    ]);
  });

  it('does not repeat a container whose name comes from its children, and bounds the list', () => {
    const before = observation([node('n1', { role: 'list' })]);
    const rows = Array.from({ length: 9 }, (_, index) =>
      node(`r${index}`, { role: 'listitem', name: `Row ${index}`, children: [node(`t${index}`, { text: `Row ${index}` })] }),
    );
    const after = observation([node('n1', { role: 'list', children: rows })]);
    const appeared = appearedText(before, after, identity);
    expect(appeared).toEqual(['Row 0', 'Row 1', 'Row 2', 'Row 3', '+5 more']);
  });

  it('quotes only what the app announces when the step landed on a new document', () => {
    const before = observation([node('n1', { role: 'document', name: 'Desk' })]);
    const after = observation([
      node('n50', {
        role: 'document',
        name: 'Catalog',
        children: [node('n51', { role: 'status', text: 'Showing 40 of 40 products' }), node('n52', { text: 'SKU' })],
      }),
    ]);
    expect(appearedText(before, after, identity)).toEqual(['Showing 40 of 40 products']);
  });

  it('quotes only announcements after a client-side route change or a re-render', () => {
    const before = observation([node('n1', { role: 'document', name: 'App', children: [node('n2', { role: 'heading', text: 'Desk' })] })]);
    const after = observation([
      node('n1', {
        role: 'document',
        name: 'App',
        children: [
          node('n3', { role: 'heading', text: 'Catalog' }),
          node('n4', { role: 'status', text: 'Showing 40 of 40 products' }),
          node('n5', { text: 'SKU' }),
        ],
      }),
    ]);
    expect(appearedText(before, after, identity, { navigated: true })).toEqual(['Showing 40 of 40 products']);
    const rows = Array.from({ length: 20 }, (_, index) => node(`r${index}`, { text: `Row ${index}` }));
    const rerendered = observation([node('n1', { role: 'document', name: 'App', children: [node('n4', { role: 'status', text: '20 rows' }), ...rows] })]);
    expect(appearedText(before, rerendered, identity)).toEqual(['20 rows']);
  });

  it('quotes a node whose text changed over the step, not one that merely stayed', () => {
    const before = observation([
      node('n1', { role: 'document', children: [node('n2', { role: 'status', text: 'No annual report yet' }), node('n3', { text: 'Footer' })] }),
    ]);
    const after = observation([
      node('n1', { role: 'document', children: [node('n2', { role: 'status', text: 'Annual report ready: 480 rows exported' }), node('n3', { text: 'Footer' })] }),
    ]);
    expect(appearedText(before, after, identity)).toEqual(['Annual report ready: 480 rows exported']);
  });

  it('returns nothing without two observations', () => {
    const only = observation([node('n1', { text: 'x' })]);
    expect(appearedText(undefined, only, identity)).toEqual([]);
    expect(appearedText(only, only, identity)).toEqual([]);
  });
});
