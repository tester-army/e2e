/** A target only a minted test id identifies: counted among the nodes of its shape, and re-found by that shape once its own id is gone. */

import { describe, expect, it } from 'vitest';
import { describePosition, relocateDescriptor } from '../../src/cache/relocate.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import type { RedactedNode } from '../../src/agent/observation.ts';
import { redactedNodes } from '../helpers/redacted.ts';

const A = 'rf__node-3f9c2a1b-7d4e-4c1a-9b2e-0a1b2c3d4e5f';
const B = 'rf__node-8e21d0c4-5b6a-4f3e-8d2c-1a0b9c8d7e6f';
const C = 'rf__node-0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

function canvasNode(id: string, testId: string, fields: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r' }, role: 'box', testId, ...fields };
}

/** A named row holding one node: the container key (`within`) is its label. */
function row(id: string, label: string, node: SemanticNode): SemanticNode[] {
  const cell = { ref: { id: `${id}-label`, revision: 'r' }, text: label };
  return [{ ref: { id, revision: 'r' }, role: 'row', children: [cell, node] }, cell, node];
}

function screen(...list: SemanticNode[]): ReadonlyMap<string, RedactedNode> {
  return redactedNodes(list);
}

const notFound = { kind: 'failed', failure: 'target-not-found' };

describe('describePosition for a target only a minted test id identifies', () => {
  it('counts the target among the nodes of its shape, even alone', () => {
    const one = screen(canvasNode('a', A));
    expect(describePosition(one.get('a')!, undefined, one)).toEqual({ index: 0, of: 1 });
    const two = screen(canvasNode('a', A), canvasNode('b', B));
    expect(describePosition(two.get('b')!, undefined, two)).toEqual({ index: 1, of: 2 });
  });

  it('records nothing for a test id that only numbers its node, or a node its name identifies', () => {
    const numbered = screen(canvasNode('a', 'rf__node-dndnode_0'), canvasNode('o', 'order-12345678'));
    expect(describePosition(numbered.get('a')!, undefined, numbered)).toBeUndefined();
    expect(describePosition(numbered.get('o')!, undefined, numbered)).toBeUndefined();
    const named = screen(canvasNode('d', A, { role: 'button', name: 'Delete' }));
    expect(describePosition(named.get('d')!, undefined, named)).toBeUndefined();
  });
});

describe('relocation by test id shape', () => {
  const alone = { role: 'box', testId: A, position: { index: 0, of: 1 } };

  it('still finds the recorded id while it is on screen', () => {
    expect(relocateDescriptor({ ...alone, position: { index: 0, of: 2 } }, screen(canvasNode('b', B), canvasNode('a', A)))).toEqual({
      kind: 'found',
      id: 'a',
    });
  });

  it('re-finds the node by its shape once the app minted it a new id', () => {
    const minted = [
      [A, B],
      ['rf__node-abcdefab-1234-4c1a-9b2e-0a1b2c3d4e5f', B],
      ['rf__node-cjld2cjxh0000qzrmn831i7rn', 'rf__node-cjld2cyuq0000t3rmniod1foy'],
      ['rf__node-652f1c3e9b1e8a0012345678', 'rf__node-652f1d0a77c4b2001234abcd'],
      ['rf__node-1697040000000', 'rf__node-1697040123456'],
    ];
    for (const [recorded, live] of minted) {
      expect(relocateDescriptor({ ...alone, testId: recorded! }, screen(canvasNode('b', live!)))).toEqual({ kind: 'found', id: 'b' });
    }
  });

  it('keeps the rest of the test id, so another control of the same record is not the target', () => {
    const remove = { ...alone, testId: `row-${A.slice(9)}-delete` };
    expect(relocateDescriptor(remove, screen(canvasNode('e', `row-${B.slice(9)}-edit`)))).toEqual(notFound);
    expect(relocateDescriptor(remove, screen(canvasNode('d', `row-${B.slice(9)}-delete`)))).toEqual({ kind: 'found', id: 'd' });
  });

  it('acts only where a place means something: alone at the recorded count, or in a named container', () => {
    expect(relocateDescriptor(alone, screen(canvasNode('x', B), canvasNode('y', C)))).toEqual({
      kind: 'failed',
      failure: 'target-ambiguous',
      candidates: ['x', 'y'],
    });
    // Two of a shape with no container are an order, which a replay may render the other way.
    expect(relocateDescriptor({ role: 'box', testId: B, position: { index: 1, of: 2 } }, screen(canvasNode('x', A), canvasNode('y', C)))).toEqual(notFound);
    const recorded = screen(...row('r1', 'Start', canvasNode('a', A)), ...row('r2', 'End', canvasNode('b', B)));
    expect(describePosition(recorded.get('b')!, 'End', recorded)).toEqual({ index: 0, of: 1 });
    const end = { role: 'box', testId: B, within: 'End', position: { index: 0, of: 1 } };
    expect(relocateDescriptor(end, screen(...row('r1', 'End', canvasNode('d', C)), ...row('r2', 'Start', canvasNode('c', A))))).toEqual({
      kind: 'found',
      id: 'd',
    });
  });

  it('is not tried without a recorded count: an entry recorded before it, or a live re-find', () => {
    expect(relocateDescriptor({ role: 'box', testId: A }, screen(canvasNode('b', B)))).toEqual(notFound);
  });

  it('is not tried for a test id that only numbers its node, nor onto a node of another role or with a name', () => {
    expect(relocateDescriptor({ ...alone, testId: 'todo-item-12' }, screen(canvasNode('b', 'todo-item-13')))).toEqual(notFound);
    expect(relocateDescriptor({ ...alone, testId: 'order-12345678' }, screen(canvasNode('b', 'order-87654321')))).toEqual(notFound);
    expect(relocateDescriptor({ ...alone, testId: 'row-1234567890' }, screen(canvasNode('b', 'row-9876543210')))).toEqual(notFound);
    expect(relocateDescriptor(alone, screen(canvasNode('b', B, { role: 'button' })))).toEqual(notFound);
    expect(relocateDescriptor(alone, screen(canvasNode('b', B, { name: 'Start' })))).toEqual(notFound);
  });
});
