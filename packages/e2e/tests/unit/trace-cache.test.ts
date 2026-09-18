/** trace-1 entry format and the replay decision. */

import { describe, expect, it } from 'vitest';
import { decideTraceReplay, type ReplayContext } from '../../src/cache/decide.ts';
import { createRedactor } from '../../src/internal/redact.ts';
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

/** The replay context of a step that sees `path` and no screen. */
function at(path: string | undefined): ReplayContext {
  return { path, nodes: undefined, redact: createRedactor(new Map()) };
}

describe('decideTraceReplay', () => {
  it('never replays a truncated trace', () => {
    expect(decideTraceReplay(entryOf(trace({ truncated: true })), at('/settings'))).toEqual({
      action: 'miss',
      reason: 'truncated',
    });
  });

  it('enforces the start-path precondition when the trace does not open with navigate', () => {
    const entry = entryOf(trace());
    expect(decideTraceReplay(entry, at('/settings')).action).toBe('replay');
    for (const currentPath of ['/other', undefined]) {
      expect(decideTraceReplay(entry, at(currentPath))).toEqual({
        action: 'miss',
        reason: 'wrong-context',
      });
    }
  });

  it('compares the start path by pathname so query strings never cold-miss', () => {
    const entry = entryOf(trace());
    expect(decideTraceReplay(entry, at('/settings?utm_source=mail')).action).toBe('replay');
    expect(decideTraceReplay(entryOf(trace({ startPath: '/settings?tab=2' })), at('/settings')).action).toBe(
      'replay',
    );
    expect(decideTraceReplay(entry, at('/settings/billing'))).toEqual({
      action: 'miss',
      reason: 'wrong-context',
    });
  });

  it('replays a navigate-opening trace from anywhere', () => {
    const entry = entryOf(trace({ actions: [navigate, tap] }));
    expect(decideTraceReplay(entry, at('/other')).action).toBe('replay');
    expect(decideTraceReplay(entry, at(undefined)).action).toBe('replay');
  });

  it('skips leading gaps when checking for the navigate opener', () => {
    const entry = entryOf(trace({ actions: [gap, navigate] }));
    expect(decideTraceReplay(entry, at('/elsewhere')).action).toBe('replay');
  });

  it('requires a recorded start path for a non-navigating trace', () => {
    const { startPath, ...rest } = trace();
    void startPath;
    expect(decideTraceReplay(entryOf(rest), at('/settings'))).toEqual({
      action: 'miss',
      reason: 'wrong-context',
    });
  });
});
