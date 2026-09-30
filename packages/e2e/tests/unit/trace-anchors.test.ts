/** End anchors: the step's delta as relocatable descriptors. */

import { describe, expect, it } from 'vitest';
import { anchorsPresent, describeAnchor, describeAnchors, missingAnchors } from '../../src/cache/anchors.ts';
import { MAX_TRACE_ANCHORS } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { createRedactor } from '../../src/internal/redact.ts';

const options = { redact: createRedactor(new Map()) };

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
    // Nodes their text names come before a node only its accessible name names.
    expect(describeAnchors(start, end, options)).toEqual([
      { role: 'status', name: 'Marker', text: 'saved' },
      { text: 'Playbook saved' },
      { role: 'link', name: 'PB-Twin-Alpha' },
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
      { text: 'you typed <secret:password>' },
      { role: 'textbox', name: 'Password' },
    ]);
  });

  it('anchors on leaves alone while any appeared; containers only repeat their children', () => {
    // Six list items, each a container over one text leaf, plus a status line
    // after the list. The observation index holds parents and children alike,
    // in document order.
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
    // Every leaf, the status line included, and no container: whether a shell
    // group is listed differs between captures, and it would hand a replay
    // off whose effect is plainly on screen.
    expect(anchors).toEqual([
      ...Array.from({ length: 6 }, (_, index) => ({ text: `Todo ${index}` })),
      { role: 'status', text: '1 remaining' },
    ]);
  });

  it('falls back to containers when nothing else appeared, up to the cap', () => {
    const groups = Array.from({ length: MAX_TRACE_ANCHORS + 2 }, (_, index) =>
      node(`g${index}`, { role: 'group', name: `Section ${index}`, children: [heading] }),
    );
    const anchors = describeAnchors(nodes([heading]), nodes([heading, ...groups]), options);
    expect(anchors).toHaveLength(MAX_TRACE_ANCHORS);
    expect(anchors[0]).toEqual({ role: 'group', name: 'Section 0' });
  });

  it('does not mistake a re-minted test id for a new node', () => {
    const before = node('t1', { role: 'button', name: 'Start sync', testId: 'toggle-r1-2' });
    const after = node('t2', { role: 'button', name: 'Start sync', testId: 'toggle-r2-2' });
    const effect = node('e', { text: 'Activate plan is on' });
    expect(describeAnchors(nodes([before]), nodes([after, effect]), options)).toEqual([
      { text: 'Activate plan is on' },
    ]);
    // A node only its test id identifies still counts by that id.
    const idOnly = node('x', { role: 'generic', testId: 'spinner' });
    expect(describeAnchors(nodes([]), nodes([idOnly]), options)).toEqual([{ role: 'generic', testId: 'spinner' }]);
  });

  it('skips text that cannot read the same twice while a stable anchor remains', () => {
    const end = nodes([
      heading,
      node('k', { text: 'sk_b1bccf4e03c5_...' }),
      node('c', { text: '6 days 23 hours remaining' }),
      node('d', { text: 'Added Sep 8, 2026' }),
      node('i', { text: '2026-09-08' }),
      node('w', { text: '17:42' }),
      node('n', { text: 'Release pipeline' }),
    ]);
    expect(describeAnchors(nodes([heading]), end, options)).toEqual([{ text: 'Release pipeline' }]);
  });

  it('keeps volatile anchors when nothing stable appeared, so the replay hands off rather than passing blind', () => {
    const end = nodes([heading, node('k', { text: 'sk_b1bccf4e03c5_...' })]);
    expect(describeAnchors(nodes([heading]), end, options)).toEqual([{ text: 'sk_b1bccf4e03c5_...' }]);
  });

  it('does not mistake progress, versions, short ids, or a named counter for volatile text', () => {
    const end = nodes([
      heading,
      node('a', { text: '3 / 30 steps' }),
      node('b', { text: 'v2.2.1' }),
      node('c', { text: 'E2E workspace 00d8365e' }),
      node('d', { role: 'status', name: 'Counter', text: '1' }),
    ]);
    expect(describeAnchors(nodes([heading]), end, options)).toHaveLength(4);
  });

  it('skips pagination ranges, record counts, millisecond timings, and bare numbers, which grow with the data', () => {
    const end = nodes([
      heading,
      node('p', { text: 'Showing 1 to 9 of 9 results' }),
      node('q', { text: 'Showing 1 to 5 of 5 results in 321ms' }),
      node('r', { text: '12 items' }),
      node('s', { text: '11' }),
      node('t', { role: 'alert', name: 'Roles' }),
    ]);
    expect(describeAnchors(nodes([heading]), end, options)).toEqual([{ role: 'alert', name: 'Roles' }]);
  });

  it('skips relative times and social tallies, which move with every step before them', () => {
    const end = nodes([
      heading,
      node('a', { text: '· now' }),
      node('b', { text: 'Posted yesterday' }),
      node('c', { role: 'text', name: '1 like', testId: 'likeCount-expanded' }),
      node('d', { role: 'button', name: 'Unlike (1 like)', testId: 'likeBtn' }),
      node('e', { role: 'button', name: 'Reply (2 replies)' }),
      node('f', { role: 'text', name: '3 followers' }),
      node('g', { role: 'text', name: 'Post text only', testId: 'postText' }),
    ]);
    expect(describeAnchors(nodes([heading]), end, options)).toEqual([{ role: 'text', name: 'Post text only', testId: 'postText' }]);
  });

  it('does not mistake a count of something else, or a word like "known", for a tally', () => {
    const end = nodes([
      heading,
      node('a', { text: '3 / 30 steps' }),
      node('b', { text: 'Well known' }),
      node('c', { text: 'Step (1 of 5)' }),
    ]);
    expect(describeAnchors(nodes([heading]), end, options)).toHaveLength(3);
  });

  it('keeps the durable anchors when the cap bites: test-id nodes first, then text, then names', () => {
    const named = Array.from({ length: MAX_TRACE_ANCHORS }, (_, index) => node(`n${index}`, { role: 'button', name: `Option ${index}` }));
    const withId = node('id', { role: 'text', name: 'Post text only', testId: 'postText' });
    const plain = node('tx', { text: 'Playbook saved' });
    const anchors = describeAnchors(nodes([heading]), nodes([heading, ...named, withId, plain]), options);
    expect(anchors).toHaveLength(MAX_TRACE_ANCHORS);
    expect(anchors.slice(0, 2)).toEqual([
      { role: 'text', name: 'Post text only', testId: 'postText' },
      { text: 'Playbook saved' },
    ]);
  });

  it('prefers a stable container over leaves that are all volatile', () => {
    const group = node('g', { role: 'group', name: 'Saved items', children: [heading] });
    const stamp = node('s', { text: 'Posted yesterday' });
    expect(describeAnchors(nodes([heading]), nodes([heading, group, stamp]), options)).toEqual([{ role: 'group', name: 'Saved items' }]);
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
    const rerendered = node('r2', { role: 'link', name: 'PB-Twin-Alpha', testId: 'row-9f8e' });
    expect(anchorsPresent([anchor], nodes([rerendered]), options)).toBe(true);
    expect(anchorsPresent([{ role: 'listitem', testId: 'row-1a2b' }], nodes([rerendered]), options)).toBe(false);
  });
});

describe('missingAnchors', () => {
  it('lists the anchors a screen does not show, in recorded order', () => {
    const rowAnchor = { role: 'link', name: 'PB-Twin-Alpha' };
    const saved = { role: 'status', name: 'Marker', text: 'saved' };
    expect(missingAnchors([rowAnchor, saved], nodes([heading]), options)).toEqual([rowAnchor, saved]);
    expect(missingAnchors([rowAnchor, saved], nodes([savedMarker]), options)).toEqual([rowAnchor]);
    expect(missingAnchors([rowAnchor, saved], nodes([savedMarker, row]), options)).toEqual([]);
  });
});

describe('describeAnchor', () => {
  it('reads like an action summary, with the test id when there is one', () => {
    expect(describeAnchor({ role: 'status', name: 'Marker', text: 'saved' })).toBe('status "Marker"');
    expect(describeAnchor({ text: 'Playbook saved' })).toBe('node "Playbook saved"');
    expect(describeAnchor({ role: 'text', name: 'Post with an image', testId: 'postText' })).toBe('text "Post with an image" (testid postText)');
    expect(describeAnchor({ role: 'generic', testId: 'spinner' })).toBe('generic (testid spinner)');
  });
});
