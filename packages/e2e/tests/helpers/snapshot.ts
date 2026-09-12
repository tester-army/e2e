/**
 * Builds an `EngineSnapshot` from a flat node list the way tests spell one:
 * a single node is the root itself, several (or none) sit under a stable
 * `root` node, and the viewport is the fake engine's.
 */

import type { EngineSnapshot, SemanticNode } from '../../src/engine/index.ts';

const SNAPSHOT_VIEWPORT = { width: 1280, height: 720, scale: 1 } as const;

export function snapshot(
  nodes: readonly SemanticNode[],
  extra: Partial<Omit<EngineSnapshot, 'root'>> = {},
): EngineSnapshot {
  const [first] = nodes;
  const root: SemanticNode =
    nodes.length === 1 && first !== undefined
      ? first
      : { ref: { id: 'root', revision: '' }, role: 'root', children: nodes };
  return { root, viewport: SNAPSHOT_VIEWPORT, ...extra };
}
