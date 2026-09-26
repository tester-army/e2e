/**
 * Re-finding a scrolled list by its place once the tree has renumbered and
 * renamed it.
 */

import { assert, describe, expect, it } from 'vitest';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';
import { prepareObservation } from '../../src/agent/observation.ts';
import { samePlace } from '../../src/agent/scroll-target.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function observationOf(tree: SemanticNode) {
  const raw: Observation = {
    kind: 'semantic',
    root: tree.ref,
    truncated: false,
    revision: 'b3',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree,
    viewport: { width: 402, height: 874 },
    redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
  };
  const result = prepareObservation(raw, { redact: (text) => text, redactCut: (text) => text, maxBytes: 65_536 });
  assert(result.kind === 'semantic');
  return result;
}

const LIST = rect(0, 96, 402, 778);
const CAROUSEL = rect(0, 300, 402, 160);

/** A renumbered screen: the main list named after its new first row, a carousel of the same role inside it. */
const screen = observationOf(
  node('root', {
    role: 'application',
    rect: rect(0, 0, 402, 874),
    children: [
      node('n40', {
        role: 'scroll-view',
        name: 'Rows 13 to 24',
        rect: LIST,
        children: [node('n41', { role: 'scroll-view', name: 'Recommended', rect: CAROUSEL })],
      }),
    ],
  }),
);

describe('samePlace', () => {
  it('re-finds the list in its old frame, not the carousel of the same role inside it', () => {
    expect(samePlace(screen, 'scroll-view', LIST)?.ref.id).toBe('n40');
  });

  it('re-finds a carousel in its old frame, and never the list around one that is gone', () => {
    expect(samePlace(screen, 'scroll-view', CAROUSEL)?.ref.id).toBe('n41');
    expect(samePlace(screen, 'scroll-view', rect(0, 600, 402, 160))).toBeUndefined();
  });

  it('holds out for the role and for a box that is mostly the same', () => {
    expect(samePlace(screen, 'list', LIST)).toBeUndefined();
    expect(samePlace(screen, 'scroll-view', rect(0, 96, 402, 300))).toBeUndefined();
  });
});
