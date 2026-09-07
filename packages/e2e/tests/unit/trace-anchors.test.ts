/** End anchors: the step's delta as relocatable descriptors (RFC0001 cache-in). */

import { describe, expect, it } from 'vitest';
import { anchorsPresent, describeAnchors } from '../../src/cache/anchors.ts';
import { MAX_TRACE_ANCHORS } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { createRedactor } from '../../src/internal/redact.ts';

const options = { redact: createRedactor(new Map()), testIdAttribute: 'data-testid' };

function nodes(list: SemanticNode[]): ReadonlyMap<string, SemanticNode> {
  return new Map(list.map((entry) => [entry.ref.id, entry]));
}

function node(id: string, fields: Omit<SemanticNode, 'ref'>): SemanticNode {
  return { ref: { id, revision: 'r' }, ...fields };
}

const heading = node('h', { role: 'heading', name: 'Playbooks' });
const emptyMarker = node('m0', { role: 'status', name: 'Marker', text: 'empty' });
const savedMarker = node('m1', { role: 'status', name: 'Marker', text: 'saved' });
const row = node('r', { role: 'link', name: 'PB-Twin-Alpha', selector: 'a[href="/pb/1"]' });
const toast = node('t', { text: 'Playbook saved' });

describe('describeAnchors', () => {
  it('keeps only what appeared, compared by descriptor rather than by id', () => {
    const start = nodes([heading, emptyMarker]);
    const end = nodes([
      // Same heading, freshly minted id: not a delta.
      node('h2', { role: 'heading', name: 'Playbooks' }),
      savedMarker,
      row,
      toast,
    ]);
    expect(describeAnchors(start, end, options)).toEqual([
      { role: 'status', name: 'Marker', text: 'saved' },
      { role: 'link', name: 'PB-Twin-Alpha' },
      { text: 'Playbook saved' },
    ]);
  });

  it('strips the structural selector and drops nodes nothing could relocate', () => {
    const end = nodes([
      row,
      node('icon', { role: 'button', selector: 'tr:nth-child(3) button' }),
      node('blank', { role: 'generic' }),
    ]);
    const anchors = describeAnchors(nodes([]), end, options);
    expect(anchors).toEqual([{ role: 'link', name: 'PB-Twin-Alpha' }]);
    expect(JSON.stringify(anchors)).not.toContain('selector');
  });

  it('deduplicates repeated descriptors and caps at the anchor limit in document order', () => {
    const end = nodes([
      ...Array.from({ length: MAX_TRACE_ANCHORS + 4 }, (_, index) =>
        node(`n${index}`, { role: 'listitem', text: `Row ${index}` }),
      ),
      node('dup', { role: 'listitem', text: 'Row 0' }),
    ]);
    const anchors = describeAnchors(nodes([]), end, options);
    expect(anchors).toHaveLength(MAX_TRACE_ANCHORS);
    expect(anchors[0]).toEqual({ role: 'listitem', text: 'Row 0' });
    expect(anchors.at(-1)).toEqual({ role: 'listitem', text: `Row ${MAX_TRACE_ANCHORS - 1}` });
  });

  it('never carries node values or secret plaintext', () => {
    const redact = createRedactor(new Map([['password', 'hunter2']]));
    const end = nodes([
      node('pw', { role: 'textbox', name: 'Password', value: 'hunter2', states: { secure: true } }),
      node('echo', { text: 'you typed hunter2' }),
    ]);
    const anchors = describeAnchors(nodes([]), end, { ...options, redact });
    expect(JSON.stringify(anchors)).not.toContain('hunter2');
    expect(anchors).toEqual([
      { role: 'textbox', name: 'Password' },
      { text: 'you typed <secret:password>' },
    ]);
  });

  it('prefers leaves over containers, which only repeat their children', () => {
    // Six list items, each a container over one text leaf, plus a status line
    // after the list: 13 new descriptors for a cap of 8. The observation index
    // holds parents and children alike, in document order.
    const flattened: SemanticNode[] = [];
    for (let index = 0; index < 6; index += 1) {
      const label = node(`t${index}`, { text: `Todo ${index}` });
      flattened.push(
        node(`li${index}`, { role: 'listitem', name: `Todo ${index}Delete Todo ${index}`, children: [label] }),
        label,
      );
    }
    flattened.push(node('status', { role: 'status', text: '1 remaining' }));
    const anchors = describeAnchors(nodes([]), nodes(flattened), options);
    expect(anchors).toHaveLength(MAX_TRACE_ANCHORS);
    // Every leaf survives — the status line included — and the cap falls on
    // the containers, whose names only repeat what the leaves already say.
    expect(anchors.slice(0, 7)).toEqual([
      ...Array.from({ length: 6 }, (_, index) => ({ text: `Todo ${index}` })),
      { role: 'status', text: '1 remaining' },
    ]);
    expect(anchors[7]).toEqual({ role: 'listitem', name: 'Todo 0Delete Todo 0' });
  });

  it('does not mistake a re-minted test id for a new node', () => {
    const before = node('t1', { role: 'button', name: 'Start sync', attributes: { 'data-testid': 'toggle-r1-2' } });
    const after = node('t2', { role: 'button', name: 'Start sync', attributes: { 'data-testid': 'toggle-r2-2' } });
    const effect = node('e', { text: 'Activate plan is on' });
    expect(describeAnchors(nodes([before]), nodes([after, effect]), options)).toEqual([
      { text: 'Activate plan is on' },
    ]);
    // A node only its test id identifies still counts by that id.
    const idOnly = node('x', { role: 'generic', attributes: { 'data-testid': 'spinner' } });
    expect(describeAnchors(nodes([]), nodes([idOnly]), options)).toEqual([{ role: 'generic', testId: 'spinner' }]);
  });

  it('is empty when nothing appeared', () => {
    expect(describeAnchors(nodes([heading, emptyMarker]), nodes([heading, emptyMarker]), options)).toEqual([]);
  });
});

describe('anchorsPresent', () => {
  const savedAnchor = { role: 'status', name: 'Marker', text: 'saved' };

  it('requires every recorded field, text included, unlike target relocation', () => {
    // Same named node, different text: the effect is missing, so the anchor is.
    expect(anchorsPresent([savedAnchor], nodes([heading, emptyMarker]), options)).toBe(false);
    expect(anchorsPresent([savedAnchor], nodes([heading, savedMarker]), options)).toBe(true);
  });

  it('is presence, not uniqueness', () => {
    const twin = node('m2', { role: 'status', name: 'Marker', text: 'saved' });
    expect(anchorsPresent([savedAnchor], nodes([savedMarker, twin]), options)).toBe(true);
  });

  it('requires every anchor, and holds trivially for none', () => {
    const rowAnchor = { role: 'link', name: 'PB-Twin-Alpha' };
    expect(anchorsPresent([savedAnchor, rowAnchor], nodes([savedMarker, row]), options)).toBe(true);
    expect(anchorsPresent([savedAnchor, rowAnchor], nodes([savedMarker]), options)).toBe(false);
    expect(anchorsPresent([], nodes([]), options)).toBe(true);
  });

  it('forgives a churned test id when the other fields still identify the node', () => {
    const anchor = { role: 'link', name: 'PB-Twin-Alpha', testId: 'row-1a2b' };
    const rerendered = node('r2', { role: 'link', name: 'PB-Twin-Alpha', attributes: { 'data-testid': 'row-9f8e' } });
    expect(anchorsPresent([anchor], nodes([rerendered]), options)).toBe(true);
    expect(anchorsPresent([{ role: 'listitem', testId: 'row-1a2b' }], nodes([rerendered]), options)).toBe(false);
  });
});
