/** trace-1 entry format and the replay decision. */

import { describe, expect, it } from 'vitest';
import { decideTraceReplay } from '../../src/cache/decide.ts';
import {
  buildTraceEntry,
  MAX_TRACE_ACTIONS,
  MAX_TRACE_ANCHORS,
  MAX_TRACE_INPUT_CHARS,
  readTraceEntry,
  type ActionTrace,
  type RecordedAction,
  type TraceEntry,
} from '../../src/cache/trace.ts';

const tap: RecordedAction = {
  name: 'tap',
  summary: 'tap button "Upgrade"',
  target: { role: 'button', name: 'Upgrade' },
};

const navigate: RecordedAction = {
  name: 'navigate',
  summary: 'navigate to "/billing"',
  url: '/billing',
};

const gap: RecordedAction = { name: 'tool', summary: 'tool seed_cart' };

function trace(overrides: Partial<ActionTrace> = {}): ActionTrace {
  return {
    actions: [tap],
    executor: { name: 'example-agent', version: '1' },
    summary: 'upgraded the plan',
    startPath: '/settings',
    ...overrides,
  };
}

/** Serializes through JSON like the store does, so hidden state cannot pass. */
function roundTrip(payload: ActionTrace): unknown {
  return JSON.parse(JSON.stringify(buildTraceEntry(payload)));
}

function entryOf(payload: ActionTrace): TraceEntry {
  const entry = readTraceEntry(roundTrip(payload));
  expect(entry).toBeDefined();
  return entry!;
}

describe('trace-1 entry', () => {
  it('round-trips every action variant through JSON', () => {
    const target = { role: 'textbox', name: 'Email' };
    const actions: RecordedAction[] = [
      navigate,
      tap,
      { name: 'type', summary: 'type "x" into textbox', target, value: 'x' },
      { name: 'typeSecret', summary: 'fill secret "pw"', target, secret: 'pw' },
      { name: 'press', summary: 'press "Enter"', target, key: 'Enter' },
      { name: 'select', summary: 'select "Pro"', target, value: 'Pro' },
      { name: 'scroll', summary: 'scroll down', direction: 'down' },
      { name: 'scroll', summary: 'scroll up on list', direction: 'up', target },
      gap,
    ];
    const entry = entryOf(trace({ actions }));
    expect(entry.schemaVersion).toBe('trace-1');
    expect(entry.payload.actions).toEqual(actions);
    expect(entry.payload.executor).toEqual({ name: 'example-agent', version: '1' });
    expect(entry.payload.startPath).toBe('/settings');
  });

  it('round-trips an empty typed value: clearing a field is a recordable action', () => {
    const target = { role: 'textbox', name: 'Name' };
    const actions: RecordedAction[] = [
      { name: 'type', summary: 'clear textbox', target, value: '' },
      { name: 'typeText', summary: 'clear the focused field', value: '', replace: true },
    ];
    expect(entryOf(trace({ actions })).payload.actions).toEqual(actions);
  });

  it('round-trips the postcondition: end path and end anchors', () => {
    const endAnchors = [
      { role: 'status', name: 'Marker', text: 'saved' },
      { text: 'Playbook saved' },
    ];
    const entry = entryOf(trace({ endPath: '/settings', endAnchors }));
    expect(entry.payload.endPath).toBe('/settings');
    expect(entry.payload.endAnchors).toEqual(endAnchors);
    // An empty list is the same as no anchors; the shape stays canonical.
    expect(entryOf(trace({ endAnchors: [] })).payload.endAnchors).toBeUndefined();
  });

  it('round-trips both sides of the delta, anchor states included, and a long location whole', () => {
    const goneAnchors = [{ role: 'listitem', name: 'Item A' }];
    const endAnchors = [{ role: 'switch', name: 'Email notifications', states: ['checked' as const, 'pressed' as const] }];
    const longPath = `/search?q=${'x'.repeat(1_000)}`;
    const entry = entryOf(trace({ startPath: longPath, endAnchors, goneAnchors }));
    expect(entry.payload).toMatchObject({ startPath: longPath, endAnchors, goneAnchors });
    expect(entryOf(trace({ goneAnchors: [] })).payload.goneAnchors).toBeUndefined();
  });

  it('drops unknown fields instead of carrying them', () => {
    const document = roundTrip(trace()) as Record<string, unknown>;
    document['extra'] = 'x';
    (document['payload'] as Record<string, unknown>)['extra'] = 'x';
    const entry = readTraceEntry(document);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('"extra"');
  });

  it.each([
    ['not an object', 'nope'],
    ['wrong schema version', { schemaVersion: 'cache-1', payload: trace() }],
    ['missing createdAt', { schemaVersion: 'trace-1', payload: trace() }],
    ['unparseable createdAt', { schemaVersion: 'trace-1', createdAt: 'not-a-date', payload: trace() }],
    ['empty actions', withPayload({ actions: [] })],
    [
      'too many actions',
      withPayload({ actions: Array.from({ length: MAX_TRACE_ACTIONS + 1 }, () => ({ ...tap })) }),
    ],
    ['unknown action name', withPayload({ actions: [{ ...tap, name: 'click' }] })],
    ['tap without a target', withPayload({ actions: [{ name: 'tap', summary: 'tap' }] })],
    ['type without a value', withPayload({ actions: [{ ...tap, name: 'type' }] })],
    ['select with an empty value', withPayload({ actions: [{ name: 'select', summary: 's', target: { role: 'x' }, value: '' }] })],
    [
      'oversized input value',
      withPayload({
        actions: [{ name: 'type', summary: 'type', target: { role: 'x' }, value: 'v'.repeat(MAX_TRACE_INPUT_CHARS + 1) }],
      }),
    ],
    ['bad scroll direction', withPayload({ actions: [{ name: 'scroll', summary: 's', direction: 'diagonal' }] })],
    ['empty summary', withPayload({ summary: '  ' })],
    ['oversized summary', withPayload({ summary: 'x'.repeat(400) })],
    ['non-string descriptor field', withPayload({ actions: [{ name: 'tap', summary: 'tap', target: { role: 7 } }] })],
    ['empty descriptor', withPayload({ actions: [{ name: 'tap', summary: 'tap', target: {} }] })],
    ['missing executor name', withPayload({ executor: { name: '' } })],
    ['non-array anchors', withPayload({ endAnchors: { role: 'status' } })],
    ['empty anchor descriptor', withPayload({ endAnchors: [{}] })],
    ['non-string anchor field', withPayload({ endAnchors: [{ text: 42 }] })],
    [
      'too many anchors',
      withPayload({ endAnchors: Array.from({ length: MAX_TRACE_ANCHORS + 1 }, (_, i) => ({ text: `a${i}` })) }),
    ],
    ['non-array gone anchors', withPayload({ goneAnchors: { role: 'status' } })],
    ['too many gone anchors', withPayload({ goneAnchors: Array.from({ length: MAX_TRACE_ANCHORS + 1 }, (_, i) => ({ text: `a${i}` })) })],
    ['unknown anchor state', withPayload({ endAnchors: [{ role: 'switch', states: ['focused'] }] })],
    ['unsorted anchor states', withPayload({ endAnchors: [{ role: 'switch', states: ['selected', 'checked'] }] })],
    ['repeated anchor state', withPayload({ endAnchors: [{ role: 'switch', states: ['checked', 'checked'] }] })],
    ['empty anchor states', withPayload({ endAnchors: [{ role: 'switch', name: 'On', states: [] }] })],
    ['oversized start path', withPayload({ startPath: `/${'x'.repeat(MAX_TRACE_INPUT_CHARS + 1)}` })],
  ])('rejects %s', (_label, document) => {
    expect(readTraceEntry(document)).toBeUndefined();
  });
});

/** A serialized entry with raw payload overrides applied after the round-trip. */
function withPayload(overrides: Record<string, unknown>): unknown {
  const raw = roundTrip(trace()) as Record<string, unknown>;
  Object.assign(raw['payload'] as Record<string, unknown>, overrides);
  return raw;
}

describe('decideTraceReplay', () => {
  it('never replays a truncated trace', () => {
    expect(decideTraceReplay(entryOf(trace({ truncated: true })), '/settings')).toEqual({
      action: 'miss',
      reason: 'truncated',
    });
  });

  it('enforces the start-path precondition when the trace does not open with navigate', () => {
    const entry = entryOf(trace());
    expect(decideTraceReplay(entry, '/settings').action).toBe('replay');
    for (const currentPath of ['/other', undefined]) {
      expect(decideTraceReplay(entry, currentPath)).toEqual({
        action: 'miss',
        reason: 'wrong-context',
      });
    }
  });

  it('compares the start path as a route: the query is part of it, its minted values and the fragment are not', () => {
    const entry = entryOf(trace());
    expect(decideTraceReplay(entry, '/settings#billing').action).toBe('replay');
    expect(decideTraceReplay(entryOf(trace({ startPath: '/settings?tab=2' })), '/settings?tab=7').action).toBe('replay');
    expect(decideTraceReplay(entryOf(trace({ startPath: '/settings?tab=notes' })), '/settings').action).toBe('miss');
    expect(decideTraceReplay(entry, '/settings?utm_source=mail').action).toBe('miss');
    expect(decideTraceReplay(entry, '/settings/billing')).toEqual({
      action: 'miss',
      reason: 'wrong-context',
    });
  });

  it('replays a navigate-opening trace from anywhere', () => {
    const entry = entryOf(trace({ actions: [navigate, tap] }));
    expect(decideTraceReplay(entry, '/other').action).toBe('replay');
    expect(decideTraceReplay(entry, undefined).action).toBe('replay');
  });

  it('skips leading gaps when checking for the navigate opener', () => {
    const entry = entryOf(trace({ actions: [gap, navigate] }));
    expect(decideTraceReplay(entry, '/elsewhere').action).toBe('replay');
  });

  it('requires a recorded start path for a non-navigating trace', () => {
    const { startPath, ...rest } = trace();
    void startPath;
    expect(decideTraceReplay(entryOf(rest), '/settings')).toEqual({
      action: 'miss',
      reason: 'wrong-context',
    });
  });
});
