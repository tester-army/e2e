/** Anonymous targets: a control with only a role relocates by its place among the unnamed controls of its kind. */

import { describe, expect, it } from 'vitest';
import { describePosition, relocateDescriptor } from '../../src/cache/relocate.ts';
import { buildTraceEntry, readTraceEntry } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { createRedactor } from '../../src/internal/redact.ts';

const options = { redact: createRedactor(new Map()) };

function textbox(id: string, name?: string): SemanticNode {
  return { ref: { id, revision: 'r' }, role: 'textbox', ...(name === undefined ? {} : { name }) };
}

function screen(...list: SemanticNode[]): ReadonlyMap<string, SemanticNode> {
  return new Map(list.map((entry) => [entry.ref.id, entry]));
}

describe('an anonymous target', () => {
  it('records its place among the unnamed controls of its kind, named ones aside', () => {
    const form = screen(textbox('name'), textbox('site', 'https://example.com'), textbox('vat'));
    expect(describePosition(form.get('name')!, undefined, form, options)).toEqual({ index: 0, of: 2 });
    expect(describePosition(form.get('vat')!, undefined, form, options)).toEqual({ index: 1, of: 2 });
    // The named one relocates by name and needs no position.
    expect(describePosition(form.get('site')!, undefined, form, options)).toBeUndefined();
  });

  it('records a position even when it is the only one, since without it nothing could relocate it', () => {
    const form = screen(textbox('name'), textbox('site', 'https://example.com'));
    expect(describePosition(form.get('name')!, undefined, form, options)).toEqual({ index: 0, of: 1 });
  });

  it('relocates to the unnamed twin at its place, never to a named control of the same role', () => {
    const recorded = { role: 'textbox', position: { index: 1, of: 2 } };
    const form = screen(textbox('a', 'Email'), textbox('b'), textbox('c'));
    expect(relocateDescriptor(recorded, form, options)).toEqual({ kind: 'found', id: 'c' });
    expect(relocateDescriptor({ role: 'textbox', position: { index: 0, of: 1 } }, screen(textbox('a', 'Email'), textbox('b')), options)).toEqual({ kind: 'found', id: 'b' });
  });

  it('diverges when the number of unnamed twins changed, or none is left', () => {
    const recorded = { role: 'textbox', position: { index: 1, of: 2 } };
    expect(relocateDescriptor(recorded, screen(textbox('a'), textbox('b'), textbox('c')), options)).toEqual({ kind: 'failed', failure: 'target-ambiguous' });
    expect(relocateDescriptor(recorded, screen(textbox('a', 'Email')), options)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('survives the trace reader with a count of one', () => {
    const entry = buildTraceEntry({
      actions: [{ name: 'type', summary: 'type "x" into textbox (1 of 1)', target: { role: 'textbox', position: { index: 0, of: 1 } }, value: 'x' }],
      executor: { name: 'test' },
      summary: 'typed',
      startPath: '/form',
    });
    expect(readTraceEntry(entry)?.payload.actions[0]).toMatchObject({ target: { role: 'textbox', position: { index: 0, of: 1 } } });
  });

  it('stays unrelocatable without a recorded position, as before', () => {
    expect(relocateDescriptor({ role: 'textbox' }, screen(textbox('a')), options)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });
});
