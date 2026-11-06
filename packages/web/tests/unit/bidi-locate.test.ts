/**
 * The Node half of a BiDi locate: the prefilter argument the page reads,
 * and the read elements built into a forest the contract's resolver walks.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type LocatorExpression } from 'e2e/engine';
import { buildForest, wantedQueries } from '../../src/bidi/observe.ts';
import type { RawNodeData } from '../../src/read-node.ts';

/** A string pattern. */
const text = (value: string, exact = false) => ({ kind: 'string' as const, value, exact });

/** A reader's node read, defaults filled in. */
function raw(fields: Partial<RawNodeData>): RawNodeData {
  return {
    role: null, name: null, labels: null, text: null, value: null, selection: null, inputPurpose: 'none',
    states: { checked: null, disabled: false, selected: null, expanded: null, pressed: null, focused: false, hidden: false, secure: false },
    level: null, attributes: {}, testId: null, rect: { x: 0, y: 0, width: 10, height: 10 }, origin: null,
    ...fields,
  };
}

describe('wantedQueries', () => {
  it('names each query with its role and patterns, and a text filter', () => {
    const expression: LocatorExpression = {
      kind: 'filter',
      hasText: text('Ada'),
      source: { kind: 'query', query: { kind: 'role', value: text('row', true), name: { kind: 'regexp', source: 'Ada', flags: 'i' } } },
    };
    expect(wantedQueries(expression)).toEqual({
      queries: [{ kind: 'role', role: 'row', value: { kind: 'string', value: 'row', exact: true }, name: { kind: 'regexp', source: 'Ada', flags: 'i' } }],
      hasText: true,
      all: false,
    });
  });

  it('reads every element for a selector', () => {
    expect(wantedQueries({ kind: 'selector', selector: '#go' })).toMatchObject({ all: true });
  });
});

describe('buildForest', () => {
  it('hangs each read under its nearest read ancestor, so a scope finds descendants', () => {
    const nodes = [raw({ role: 'list', name: 'Todos' }), raw({ role: 'listitem', text: 'One' }), raw({ role: 'button', name: 'Delete One' })];
    const roots = buildForest(nodes, [-1, 0, 1], ['n1', 'n2', 'n3']);
    const scoped: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: text('button', true) },
      scope: { kind: 'query', query: { kind: 'role', value: text('list', true), name: text('Todos') } },
    };
    expect(resolveExpression(scoped, roots).map((node) => node.ref.id)).toEqual(['n3']);
  });

  it('names a hidden control by its label, as Playwright’s getByLabel finds it', () => {
    const roots = buildForest([raw({ labels: ['Hidden pad'], states: { ...raw({}).states, hidden: true } })], [-1], ['n1']);
    expect(resolveExpression({ kind: 'query', query: { kind: 'label', value: text('Hidden pad', true) } }, roots).map((node) => node.ref.id)).toEqual(['n1']);
  });
});
