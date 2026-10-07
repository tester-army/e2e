/** Anchors: the step's delta as relocatable descriptors, both what appeared and what vanished. */

import { describe, expect, it } from 'vitest';
import { deltaEvidenced, deltaHolds, describeDelta } from '../../src/cache/anchors.ts';
import { MAX_TRACE_ANCHORS } from '../../src/cache/trace.ts';
import type { RedactedNode } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { createRedactor } from '../../src/internal/redact.ts';
import { redactedNodes } from '../helpers/redacted.ts';

function nodes(list: SemanticNode[]): ReadonlyMap<string, RedactedNode> {
  return redactedNodes(list);
}

function node(id: string, fields: Omit<SemanticNode, 'ref'>): SemanticNode {
  return { ref: { id, revision: 'r' }, ...fields };
}

const appeared = (start: ReadonlyMap<string, RedactedNode>, end: ReadonlyMap<string, RedactedNode>) => describeDelta(start, end, false).appeared;
const none = nodes([]);

const heading = node('h', { role: 'heading', name: 'Playbooks' });
const emptyMarker = node('m0', { role: 'status', name: 'Marker', text: 'empty' });
const savedMarker = node('m1', { role: 'status', name: 'Marker', text: 'saved' });
const row = node('r', { role: 'link', name: 'PB-Twin-Alpha', selector: 'a[href="/pb/1"]' });
const toast = node('t', { text: 'Playbook saved' });

describe('describeDelta', () => {
  it('keeps what appeared and what vanished, compared by descriptor rather than by id', () => {
    const start = nodes([heading, emptyMarker]);
    const end = nodes([
      // Same heading, freshly minted id: not a delta.
      node('h2', { role: 'heading', name: 'Playbooks' }),
      savedMarker,
      row,
      toast,
    ]);
    expect(describeDelta(start, end, false)).toEqual({
      appeared: [
        { role: 'status', name: 'Marker', text: 'saved' },
        { role: 'link', name: 'PB-Twin-Alpha' },
        { text: 'Playbook saved' },
      ],
      gone: [{ role: 'status', name: 'Marker', text: 'empty' }],
    });
  });

  it('records a removal as what vanished, so a delete has something to check', () => {
    const itemA = node('a', { role: 'listitem', name: 'Item A' });
    const itemB = node('b', { role: 'listitem', name: 'Item B' });
    expect(describeDelta(nodes([heading, itemA, itemB]), nodes([heading, itemB]), false)).toEqual({
      appeared: [],
      gone: [{ role: 'listitem', name: 'Item A' }],
    });
  });

  it('records the states a step set on a control it left on screen', () => {
    const off = node('s1', { role: 'switch', name: 'Email notifications', states: { checked: false, focused: false } });
    const on = node('s2', { role: 'switch', name: 'Email notifications', states: { checked: true, focused: true } });
    // Focus is where the pointer went, not what the step did.
    expect(describeDelta(nodes([heading, off]), nodes([heading, on]), false)).toEqual({
      appeared: [{ role: 'switch', name: 'Email notifications', states: ['checked'] }],
      gone: [{ role: 'switch', name: 'Email notifications' }],
    });
  });

  it('strips the structural selector and drops nodes nothing could relocate', () => {
    const end = nodes([
      row,
      node('icon', { role: 'button', selector: 'tr:nth-child(3) button' }),
      node('blank', { role: 'generic' }),
    ]);
    const anchors = appeared(none, end);
    expect(anchors).toEqual([{ role: 'link', name: 'PB-Twin-Alpha' }]);
    expect(JSON.stringify(anchors)).not.toContain('selector');
  });

  it('deduplicates repeated descriptors and caps each side at the anchor limit in document order', () => {
    const list = Array.from({ length: MAX_TRACE_ANCHORS + 4 }, (_, index) => node(`n${index}`, { role: 'listitem', text: `Row ${index}` }));
    const end = nodes([...list, node('dup', { role: 'listitem', text: 'Row 0' })]);
    const delta = describeDelta(none, end, false);
    expect(delta.appeared).toHaveLength(MAX_TRACE_ANCHORS);
    expect(delta.appeared[0]).toEqual({ role: 'listitem', text: 'Row 0' });
    expect(delta.appeared.at(-1)).toEqual({ role: 'listitem', text: `Row ${MAX_TRACE_ANCHORS - 1}` });
    expect(describeDelta(end, none, false).gone).toEqual(delta.appeared);
  });

  it('records the value a step typed into a field, redacted, and never a secure field\'s', () => {
    const redact = createRedactor(new Map([['token', 'tok_9f8e7d6c5b4a3210']]));
    const empty = node('e0', { role: 'textbox', name: 'Email' });
    const typed = node('e1', { role: 'textbox', name: 'Email', value: 'ada@example.test' });
    const leaked = node('k1', { role: 'textbox', name: 'Key', value: 'tok_9f8e7d6c5b4a3210' });
    const end = redactedNodes([typed, leaked], { redact, redactCut: redact });
    expect(describeDelta(nodes([empty]), end, false)).toEqual({
      appeared: [
        { role: 'textbox', name: 'Email', value: 'ada@example.test' },
        { role: 'textbox', name: 'Key', value: '<secret:token>' },
      ],
      gone: [{ role: 'textbox', name: 'Email' }],
    });
  });

  it('never carries a secure value or secret plaintext', () => {
    const redact = createRedactor(new Map([['password', 'hunter2']]));
    const end = redactedNodes(
      [
        node('pw', { role: 'textbox', name: 'Password', value: 'hunter2', states: { secure: true } }),
        node('echo', { text: 'you typed hunter2' }),
      ],
      { redact, redactCut: redact },
    );
    const anchors = describeDelta(none, end, false).appeared;
    expect(JSON.stringify(anchors)).not.toContain('hunter2');
    expect(anchors).toEqual([
      { role: 'textbox', name: 'Password' },
      { text: 'you typed <secret:password>' },
    ]);
  });

  it('records one anchor per label, the one with a test id, since which wrappers a platform reports varies', () => {
    // One iOS accessibility backend reports the status and a wrapper named after it; another reports only the status.
    const status = node('s', { role: 'text', name: 'Flow completed', testId: 'success-message' });
    const wrapper = node('w', { role: 'other', name: 'Flow completed' });
    const recorded = appeared(nodes([heading]), nodes([heading, wrapper, status]));
    expect(recorded).toEqual([{ role: 'text', name: 'Flow completed', testId: 'success-message' }]);
    expect(deltaHolds({ endAnchors: recorded }, nodes([heading, status]), nodes([heading]))).toBe(true);
    // Nested wrappers of a removed button collapse the same way on the gone side.
    const button = node('b', { role: 'other', name: 'Open modal', testId: 'open-modal-button' });
    const outer = node('o', { role: 'other', name: 'Open modal', children: [button] });
    expect(describeDelta(nodes([heading, outer, button]), nodes([heading]), false).gone).toEqual([
      { role: 'other', name: 'Open modal', testId: 'open-modal-button' },
    ]);
    // A wrapper with a test id never takes the slot from the status it wraps.
    const plain = node('p', { role: 'status', name: 'Saved' });
    const tagged = node('g', { role: 'other', name: 'Saved', testId: 'save-banner', children: [plain] });
    expect(appeared(nodes([heading]), nodes([heading, tagged, plain]))).toEqual([{ role: 'status', name: 'Saved' }]);
    // Fields reading one label with different values are different effects.
    const first = node('f1', { role: 'textbox', name: 'Email', value: 'a@x.test' });
    const second = node('f2', { role: 'textbox', name: 'Email', value: 'b@x.test' });
    expect(appeared(nodes([heading]), nodes([heading, first, second]))).toHaveLength(2);
  });

  it('puts announcements first, then leaves, then containers, which only repeat their children', () => {
    // Ten list items, each a container over one text leaf, plus a status line
    // after the list: 21 new descriptors for a cap of 8. The observation index
    // holds parents and children alike, in document order.
    const flattened: SemanticNode[] = [];
    for (let index = 0; index < 10; index += 1) {
      const label = node(`t${index}`, { text: `Todo ${index}` });
      flattened.push(node(`li${index}`, { role: 'listitem', name: `Todo ${index}Delete Todo ${index}`, children: [label] }), label);
    }
    flattened.push(node('status', { role: 'status', text: 'Report ready' }));
    const anchors = appeared(none, nodes(flattened));
    expect(anchors).toHaveLength(MAX_TRACE_ANCHORS);
    // The app's own announcement of the outcome is never what the cap cuts.
    expect(anchors[0]).toEqual({ role: 'status', text: 'Report ready' });
    expect(anchors.slice(1)).toEqual(Array.from({ length: MAX_TRACE_ANCHORS - 1 }, (_, index) => ({ text: `Todo ${index}` })));
  });

  it('does not mistake a re-minted test id for a new node', () => {
    const before = node('t1', { role: 'button', name: 'Start sync', testId: 'toggle-r1-2' });
    const after = node('t2', { role: 'button', name: 'Start sync', testId: 'toggle-r2-2' });
    const effect = node('e', { text: 'Activate plan is on' });
    expect(appeared(nodes([before]), nodes([after, effect]))).toEqual([{ text: 'Activate plan is on' }]);
    // A node only its test id identifies still counts by that id.
    const idOnly = node('x', { role: 'generic', testId: 'spinner' });
    expect(appeared(none, nodes([idOnly]))).toEqual([{ role: 'generic', testId: 'spinner' }]);
  });

  it('skips text that cannot read the same twice while a stable anchor remains', () => {
    const end = nodes([
      heading,
      node('k', { text: 'sk_b1bccf4e03c5_...' }),
      node('c', { text: '6 days 23 hours remaining' }),
      node('d', { text: 'Added Sep 8, 2026' }),
      node('i', { text: '2026-09-08' }),
      node('w', { text: '17:42' }),
      node('q', { text: 'Done in 321ms' }),
      node('s', { text: '11' }),
      node('n', { text: 'Release pipeline' }),
    ]);
    expect(appeared(nodes([heading]), end)).toEqual([{ text: 'Release pipeline' }]);
  });

  it('keeps volatile anchors when nothing stable appeared, so the replay hands off rather than passing blind', () => {
    const end = nodes([heading, node('k', { text: 'sk_b1bccf4e03c5_...' })]);
    expect(appeared(nodes([heading]), end)).toEqual([{ text: 'sk_b1bccf4e03c5_...' }]);
  });

  it('reads an alert whose countdown ticked during the step as the alert that stayed', () => {
    const banner = (id: string, minutes: number) => node(id, { role: 'alert', text: `Session expires in ${String(minutes)} minutes` });
    expect(describeDelta(nodes([heading, banner('a', 5)]), nodes([heading, banner('b', 4), toast]), false)).toEqual({
      appeared: [{ text: 'Playbook saved' }],
      gone: [],
    });
  });

  it('keeps every alert, whatever its text, since a replay is checked for alerts it raised', () => {
    const end = nodes([heading, node('a', { role: 'alert', text: 'Session expires at 17:42' }), node('n', { text: 'Release pipeline' })]);
    expect(appeared(nodes([heading]), end)).toEqual([{ role: 'alert', text: 'Session expires at 17:42' }, { text: 'Release pipeline' }]);
  });

  it('does not mistake progress, versions, short ids, or a named counter for volatile text', () => {
    const end = nodes([
      heading,
      node('a', { text: '3 / 30 steps' }),
      node('b', { text: 'v2.2.1' }),
      node('c', { text: 'E2E workspace 00d8365e' }),
      node('d', { role: 'status', name: 'Counter', text: '1' }),
    ]);
    expect(appeared(nodes([heading]), end)).toHaveLength(4);
  });

  it('keeps a count the step made appear, which is its result, and skips one that only moved or that came with another route, which is the data', () => {
    const imported = nodes([heading, node('i', { role: 'status', text: '3 records imported' }), node('p', { text: 'Showing 1 to 9 of 9 results' })]);
    expect(appeared(nodes([heading]), imported)).toEqual([{ role: 'status', text: '3 records imported' }, { text: 'Showing 1 to 9 of 9 results' }]);
    // The same screen opened by a link: its counts are what the list holds today.
    expect(describeDelta(nodes([heading]), nodes([...imported.values(), node('n', { text: 'Imported records' })]), true).appeared).toEqual([
      { text: 'Imported records' },
    ]);
    // A tally that was there before the step and reads another number after it grows with every run's leftovers.
    const before = nodes([heading, node('c0', { text: '41 items' })]);
    const after = nodes([heading, node('c1', { text: '42 items' }), node('n', { text: 'Item added' })]);
    expect(describeDelta(before, after, false)).toEqual({ appeared: [{ text: 'Item added' }], gone: [{ text: '41 items' }] });
  });

  describe('a radio the pick replaces with its summary', () => {
    const radio = (id: string, name: string) => node(id, { role: 'radio', name });
    const label = (id: string, text: string) => node(id, { text });
    const deliveryState = (text: string) => node(`state-${text}`, { role: 'status', name: 'Delivery state', text });
    const picker = [radio('r1', 'Standard'), label('l1', 'Standard'), radio('r2', 'Express'), label('l2', 'Express')];
    const start = nodes([heading, ...picker, deliveryState('unset')]);
    const summary = [node('summary', { text: 'Express delivery selected' }), node('change', { role: 'button', name: 'Change delivery' })];
    const end = nodes([heading, ...summary, deliveryState('Express')]);
    const delta = describeDelta(start, end, false);
    const recorded = { endAnchors: delta.appeared, goneAnchors: delta.gone };

    it('holds on the screen it was recorded on, so a faithful replay passes', () => {
      expect(deltaHolds(recorded, end, start)).toBe(true);
    });

    it('records no vanished label that a node left on screen still reads as', () => {
      // The status reads "Express" too: the label is gone, but an anchor of its text alone is not.
      expect(delta.gone).not.toContainEqual({ text: 'Express' });
      expect(delta.gone).toContainEqual({ role: 'radio', name: 'Express' });
      // The radio and its label read one label: one anchor stands for both.
      expect(delta.gone).not.toContainEqual({ text: 'Standard' });
      expect(delta.gone).toContainEqual({ role: 'radio', name: 'Standard' });
    });

    it('still fails a replay whose pick left the radios on screen', () => {
      expect(deltaHolds(recorded, start, start)).toBe(false);
      expect(deltaHolds(recorded, nodes([heading, ...picker, ...summary, deliveryState('Express')]), start)).toBe(false);
    });
  });

  it('is empty when nothing changed', () => {
    expect(describeDelta(nodes([heading, emptyMarker]), nodes([heading, emptyMarker]), false)).toEqual({ appeared: [], gone: [] });
  });
});

describe('deltaHolds', () => {
  const savedAnchor = { role: 'status', name: 'Marker', text: 'saved' };
  const holds = (endAnchors: object[], live: SemanticNode[], start: SemanticNode[] = [], goneAnchors: object[] = []) =>
    deltaHolds({ endAnchors, goneAnchors }, nodes(live), nodes(start));

  it('requires every recorded field, text included, unlike target relocation', () => {
    // Same named node, different text: the effect is missing, so the anchor is.
    expect(holds([savedAnchor], [heading, emptyMarker])).toBe(false);
    expect(holds([savedAnchor], [heading, savedMarker])).toBe(true);
  });

  it('is presence, not uniqueness', () => {
    const twin = node('m2', { role: 'status', name: 'Marker', text: 'saved' });
    expect(holds([savedAnchor], [savedMarker, twin])).toBe(true);
  });

  it('requires every anchor', () => {
    const rowAnchor = { role: 'link', name: 'PB-Twin-Alpha' };
    expect(holds([savedAnchor, rowAnchor], [savedMarker, row])).toBe(true);
    expect(holds([savedAnchor, rowAnchor], [savedMarker])).toBe(false);
  });

  it('requires every vanished node to be gone again', () => {
    const itemA = node('a', { role: 'listitem', name: 'Item A' });
    expect(holds([], [heading], [heading, itemA], [{ role: 'listitem', name: 'Item A' }])).toBe(true);
    expect(holds([], [heading, itemA], [heading, itemA], [{ role: 'listitem', name: 'Item A' }])).toBe(false);
  });

  it('requires the recorded states, so a switch that stayed off is not the switch turned on', () => {
    const on = { role: 'switch', name: 'Email notifications', states: ['checked'] };
    expect(holds([on], [node('s', { role: 'switch', name: 'Email notifications', states: { checked: true } })])).toBe(true);
    expect(holds([on], [node('s', { role: 'switch', name: 'Email notifications', states: { checked: false } })])).toBe(false);
    // An anchor recorded without a state does not match the control with one either.
    expect(holds([{ role: 'switch', name: 'Email notifications' }], [node('s', { role: 'switch', name: 'Email notifications', states: { checked: true } })])).toBe(false);
  });

  it('fails on an alert the replay raised that the recording never saw, and not on one already there', () => {
    const declined = node('d', { role: 'alert', text: 'Card declined' });
    expect(holds([savedAnchor], [savedMarker, declined])).toBe(false);
    expect(holds([savedAnchor], [savedMarker, declined], [declined])).toBe(true);
    expect(holds([savedAnchor, { role: 'alert', text: 'Card declined' }], [savedMarker, declined])).toBe(true);
  });

  it('reads the volatile parts of an alert as placeholders, both for the recorded one and for one already there', () => {
    const expiring = (id: string, at: string) => node(id, { role: 'alert', text: `Session expires at ${at}` });
    expect(holds([{ role: 'alert', text: 'Session expires at 17:42' }], [expiring('a', '17:45')])).toBe(true);
    expect(holds([savedAnchor], [savedMarker, expiring('a', '17:45')], [expiring('b', '17:44')])).toBe(true);
    expect(holds([{ role: 'alert', text: 'Session expires at 17:42' }], [node('x', { role: 'alert', text: 'Session expired' })])).toBe(false);
  });

  it('reads the volatile parts of any anchor as placeholders, so a recording whose only effect reads a time passes its own replay', () => {
    const start = nodes([heading]);
    const delta = describeDelta(start, nodes([heading, node('s', { role: 'status', text: 'Saved at 10:42' })]), false);
    expect(delta.appeared).toEqual([{ role: 'status', text: 'Saved at 10:42' }]);
    const recorded = { endAnchors: delta.appeared, goneAnchors: delta.gone };
    const replayEnd = nodes([heading, node('s2', { role: 'status', text: 'Saved at 10:45' })]);
    expect(deltaHolds(recorded, replayEnd, start)).toBe(true);
    expect(deltaEvidenced(recorded, start, [])).toBe(true);
    // The same status already on screen before the replay acted proves nothing.
    expect(deltaEvidenced(recorded, nodes([heading, node('s0', { role: 'status', text: 'Saved at 09:58' })]), [])).toBe(false);
    expect(deltaHolds(recorded, nodes([heading, node('s3', { role: 'status', text: 'Save failed' })]), start)).toBe(false);
  });

  it('compares a field\'s value exactly, even when it reads a date or a duration: the value is the step\'s effect', () => {
    const picked = { role: 'textbox', name: 'Due date', value: '2026-10-05' };
    expect(holds([picked], [node('d', { role: 'textbox', name: 'Due date', value: '2026-10-05' })])).toBe(true);
    expect(holds([picked], [node('d', { role: 'textbox', name: 'Due date', value: '2026-10-06' })])).toBe(false);
  });

  it('forgives a churned test id when the other fields still identify the node', () => {
    const anchor = { role: 'link', name: 'PB-Twin-Alpha', testId: 'row-1a2b' };
    const rerendered = node('r2', { role: 'link', name: 'PB-Twin-Alpha', testId: 'row-9f8e' });
    expect(holds([anchor], [rerendered])).toBe(true);
    expect(holds([{ role: 'listitem', testId: 'row-1a2b' }], [rerendered])).toBe(false);
  });

  it('finds a status by its test id when the region around it was relabeled, and still requires what it reads', () => {
    const anchor = { role: 'region', name: 'Save status', text: 'Saved', testId: 'save' };
    expect(holds([anchor], [node('r', { role: 'region', name: 'Draft status', text: 'Saved', testId: 'save' })])).toBe(true);
    expect(holds([anchor], [node('r', { role: 'region', name: 'Draft status', text: 'Saving', testId: 'save' })])).toBe(false);
  });

  it('reads the name of a node that says nothing else as its content, and keeps the node by its test id across a role change', () => {
    const anchor = { role: 'text', name: 'Receipt attached: icon.png', testId: 'success-message' };
    expect(holds([anchor], [node('t', { role: 'other', name: 'Receipt attached: icon.png', testId: 'success-message' })])).toBe(true);
    expect(holds([anchor], [node('t', { role: 'text', name: 'Upload failed', testId: 'success-message' })])).toBe(false);
  });

  it('never counts the recorded reading on another node while the recorded test id is on screen reading something else', () => {
    const anchor = { role: 'text', name: 'Saved', testId: 'save-message' };
    const failed = node('m', { role: 'text', name: 'Save failed', testId: 'save-message' });
    const elsewhere = node('o', { role: 'text', name: 'Saved' });
    expect(holds([anchor], [failed, elsewhere])).toBe(false);
    // With the test id gone, a node reading the same is a re-minted id, as before.
    expect(holds([anchor], [elsewhere])).toBe(true);
  });

  it('sees a vanished label as gone when its control stayed and now reads otherwise, and fails when the evidence disagrees', () => {
    const gone = { role: 'button', name: 'Choose photo', testId: 'choose-photo' };
    expect(holds([], [node('b', { role: 'button', name: 'Change photo', testId: 'choose-photo' })], [], [gone])).toBe(true);
    expect(holds([], [node('b', { role: 'button', name: 'Choose photo', testId: 'choose-photo' })], [], [gone])).toBe(false);
    const pending = { role: 'status', name: 'Upload', text: 'Pending', testId: 'upload-status' };
    const done = node('u', { role: 'status', name: 'Upload', text: 'Done', testId: 'upload-status' });
    const stale = node('s', { role: 'status', name: 'Upload', text: 'Pending' });
    expect(holds([], [done], [], [pending])).toBe(true);
    expect(holds([], [done, stale], [], [pending])).toBe(false);
  });
});

describe('deltaEvidenced', () => {
  const submitted = node('s', { role: 'status', text: 'Submitted' });
  const draft = node('d', { role: 'status', text: 'Draft' });
  const delta = { endAnchors: [{ role: 'status', text: 'Submitted' }], goneAnchors: [{ role: 'status', text: 'Draft' }] };

  it('holds when some recorded change was not already on the screen the replay began on', () => {
    expect(deltaEvidenced(delta, nodes([heading, draft]), [])).toBe(true);
    expect(deltaEvidenced({ endAnchors: [{ role: 'status', text: 'Submitted' }] }, nodes([heading]), [])).toBe(true);
  });

  it('fails when the outcome already showed before the first action, a submit that did nothing', () => {
    expect(deltaEvidenced(delta, nodes([heading, submitted]), [])).toBe(false);
  });

  it('fails for a recording with no delta unless the last action moved the route, leaving no baseline on the end route', () => {
    expect(deltaEvidenced({}, nodes([heading]), [])).toBe(false);
    expect(deltaEvidenced({}, undefined, [])).toBe(true);
  });

  it('counts a value the step typed only when the step changed nothing else', () => {
    const email = { role: 'textbox', name: 'Email' };
    const typed = { ...email, value: 'ada@example.test' };
    const subscribed = node('ok', { role: 'status', text: "You're subscribed" });
    const form = { endAnchors: [typed, { role: 'status', text: "You're subscribed" }], goneAnchors: [email] };
    // The page already read the outcome when the replay typed: the typed value alone proves nothing.
    expect(deltaEvidenced(form, nodes([heading, node('e', { ...email }), subscribed]), [email])).toBe(false);
    expect(deltaEvidenced(form, nodes([heading, node('e', { ...email })]), [email])).toBe(true);
    // A step that only fills a field has nothing but the value to show.
    expect(deltaEvidenced({ endAnchors: [typed], goneAnchors: [email] }, nodes([heading, node('e', { ...email })]), [email])).toBe(true);
  });
});
