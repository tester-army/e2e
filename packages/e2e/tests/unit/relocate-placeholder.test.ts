/** A field named only by its placeholder is recorded and relocated by it. */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { describeTarget } from '../../src/agent/actions.ts';
import { relocateDescriptor } from '../../src/cache/relocate.ts';

const identity = (text: string): string => text;

function textbox(id: string, placeholder: string, name?: string): SemanticNode {
  return {
    ref: { id, revision: 'r' },
    role: 'textbox',
    ...(name === undefined ? {} : { name }),
    attributes: { type: 'search', placeholder },
  };
}

describe('relocation by placeholder', () => {
  it('records the placeholder on the descriptor beside the name the engine derived from it', () => {
    const descriptor = describeTarget(textbox('n1', 'Search products', 'Search products'), identity);
    expect(descriptor).toEqual({ role: 'textbox', name: 'Search products', placeholder: 'Search products' });
  });

  it('relocates an unnamed field by its placeholder alone', () => {
    const descriptor = describeTarget(textbox('n1', 'Search products'), identity);
    expect(descriptor).toEqual({ role: 'textbox', placeholder: 'Search products' });

    const nodes = new Map<string, SemanticNode>([
      ['m1', textbox('m1', 'Filter tags')],
      ['m2', textbox('m2', 'Search products')],
    ]);
    expect(relocateDescriptor(descriptor!, nodes, { redact: identity })).toEqual({ kind: 'found', id: 'm2' });
  });

  it('fails instead of guessing when the placeholder changed or repeats', () => {
    const descriptor = describeTarget(textbox('n1', 'Search products'), identity)!;
    const renamed = new Map<string, SemanticNode>([['m1', textbox('m1', 'Find products')]]);
    expect(relocateDescriptor(descriptor, renamed, { redact: identity })).toEqual({
      kind: 'failed',
      failure: 'target-not-found',
    });
    const twins = new Map<string, SemanticNode>([
      ['m1', textbox('m1', 'Search products')],
      ['m2', textbox('m2', 'Search products')],
    ]);
    expect(relocateDescriptor(descriptor, twins, { redact: identity })).toEqual({
      kind: 'failed',
      failure: 'target-ambiguous',
      candidates: ['m1', 'm2'],
    });
  });
});
