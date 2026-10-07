/** A field named only by its placeholder is recorded and relocated by it. */

import { describe, expect, it } from 'vitest';
import type { RedactedNode } from '../../src/agent/observation.ts';
import { redacted } from '../helpers/redacted.ts';
import { describeTarget } from '../../src/agent/actions.ts';
import { relocateExact } from '../../src/cache/locate.ts';

function textbox(id: string, placeholder: string, name?: string): RedactedNode {
  return redacted({
    ref: { id, revision: 'r' },
    role: 'textbox',
    ...(name === undefined ? {} : { name }),
    attributes: { type: 'search', placeholder },
  });
}

describe('relocation by placeholder', () => {
  it('records the placeholder on the descriptor beside the name the engine derived from it', () => {
    const descriptor = describeTarget(textbox('n1', 'Search products', 'Search products'));
    expect(descriptor).toEqual({ role: 'textbox', name: 'Search products', placeholder: 'Search products' });
  });

  it('relocates an unnamed field by its placeholder alone', () => {
    const descriptor = describeTarget(textbox('n1', 'Search products'));
    expect(descriptor).toEqual({ role: 'textbox', placeholder: 'Search products' });

    const nodes = new Map<string, RedactedNode>([
      ['m1', textbox('m1', 'Filter tags')],
      ['m2', textbox('m2', 'Search products')],
    ]);
    expect(relocateExact(descriptor!, nodes)).toEqual({ kind: 'found', id: 'm2' });
  });

  it('fails instead of guessing when the placeholder changed or repeats', () => {
    const descriptor = describeTarget(textbox('n1', 'Search products'))!;
    const renamed = new Map<string, RedactedNode>([['m1', textbox('m1', 'Find products')]]);
    expect(relocateExact(descriptor, renamed)).toEqual({
      kind: 'failed',
      failure: 'target-not-found',
    });
    const twins = new Map<string, RedactedNode>([
      ['m1', textbox('m1', 'Search products')],
      ['m2', textbox('m2', 'Search products')],
    ]);
    expect(relocateExact(descriptor, twins)).toEqual({
      kind: 'failed',
      failure: 'target-ambiguous',
      candidates: ['m1', 'm2'],
    });
  });
});
