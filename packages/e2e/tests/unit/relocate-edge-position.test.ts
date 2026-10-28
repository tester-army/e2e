import { describe, expect, it } from 'vitest';
import { relocateDescriptor } from '../../src/cache/relocate.ts';
import { buildTraceEntry, readTraceEntry, type ActionTrace } from '../../src/cache/trace.ts';
import { redactedNodes } from '../helpers/redacted.ts';

/** Repeated rows with fresh labels and an unrelated control before them. */
function rows(...ids: string[]) {
  return redactedNodes([
    { ref: { id: 'unrelated', revision: 'r' }, role: 'group', testId: 'other-item' },
    ...ids.map((id) => ({ ref: { id, revision: 'r' }, role: 'group', testId: 'inbox-item', name: `Message ${id}` })),
  ]);
}

/** The experimental descriptor represents explicit intent, independent of row content. */
function descriptor(edge: 'first' | 'last') {
  return { role: 'group', testId: 'inbox-item', ordinal: edge };
}

describe('explicit edge positions', () => {
  it.each(['first', 'last'] as const)('selects the %s row as the count grows and shrinks', (edge) => {
    for (const ids of [['a'], ['a', 'b'], ['new', 'b', 'c', 'old']]) {
      expect(relocateDescriptor(descriptor(edge), rows(...ids))).toEqual({ kind: 'found', id: edge === 'first' ? ids[0] : ids.at(-1) });
    }
  });

  it('uses live document order after a reorder', () => {
    expect(relocateDescriptor(descriptor('first'), rows('c', 'a', 'b'))).toEqual({ kind: 'found', id: 'c' });
    expect(relocateDescriptor(descriptor('last'), rows('c', 'a', 'b'))).toEqual({ kind: 'found', id: 'b' });
  });

  it('hands off an empty list', () => {
    expect(relocateDescriptor(descriptor('first'), rows())).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('does not fall back to unrelated rows when the test id disappears', () => {
    const nodes = redactedNodes([{ ref: { id: 'wrong', revision: 'r' }, role: 'group', testId: 'other-item' }]);
    expect(relocateDescriptor(descriptor('first'), nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('keeps the recorded role as a constraint', () => {
    const nodes = redactedNodes([{ ref: { id: 'wrong', revision: 'r' }, role: 'button', testId: 'inbox-item' }]);
    expect(relocateDescriptor(descriptor('first'), nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('preserves ambiguity without explicit intent', () => {
    expect(relocateDescriptor({ role: 'group', testId: 'inbox-item' }, rows('a', 'b'))).toMatchObject({ kind: 'failed', failure: 'target-ambiguous' });
  });

  it('round trips first and last through the file format', () => {
    for (const edge of ['first', 'last'] as const) {
      const payload: ActionTrace = { executor: { name: 'proof' }, summary: 'opened', actions: [{ name: 'tap', summary: 'open a row', target: descriptor(edge) }] };
      expect(readTraceEntry(JSON.parse(JSON.stringify(buildTraceEntry(payload))))?.payload.actions[0]).toMatchObject({ target: descriptor(edge) });
    }
  });

  it('round trips positional provenance and rejects malformed digests', () => {
    const recordedFor = { testId: 'test', targetId: 'target', instructionDigest: 'a'.repeat(64), positionDigest: 'b'.repeat(64) };
    const payload: ActionTrace = { recordedFor, executor: { name: 'proof' }, summary: 'opened', actions: [{ name: 'tap', summary: 'open a row', target: descriptor('first') }] };
    expect(readTraceEntry(buildTraceEntry(payload))?.payload.recordedFor).toEqual(recordedFor);
    for (const positionDigest of ['', 'not-a-digest', 42]) {
      const entry = buildTraceEntry(payload);
      const invalid = { ...entry, payload: { ...payload, recordedFor: { ...recordedFor, positionDigest } } };
      expect(readTraceEntry(invalid)).toBeUndefined();
    }
  });

  it('rejects malformed positions and contradictory identity fields', () => {
    const payload: ActionTrace = { executor: { name: 'proof' }, summary: 'opened', actions: [{ name: 'tap', summary: 'open a row', target: descriptor('first') }] };
    const entry = buildTraceEntry(payload);
    for (const target of [
      { ...descriptor('first'), ordinal: 'middle' },
      { ...descriptor('first'), position: { index: 0, of: 2 } },
      { ...descriptor('first'), within: 'Old message' },
      { ...descriptor('first'), name: 'Old message' },
      { ...descriptor('first'), text: 'Old message' },
      { role: 'group', ordinal: 'first' },
    ]) {
      const broken = { ...entry, payload: { ...payload, actions: [{ ...payload.actions[0], target }] } };
      expect(readTraceEntry(broken)).toBeUndefined();
    }
  });
});
