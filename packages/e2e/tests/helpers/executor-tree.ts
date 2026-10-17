/** Reading the node tree an executor gets from `observe({ tree: true })`. */

import type { ExecutorNode } from '../../src/agent/executor.ts';

/** The first node `match` accepts, depth first. */
export function findNode(node: ExecutorNode | undefined, match: (node: ExecutorNode) => boolean): ExecutorNode | undefined {
  if (node === undefined) return undefined;
  if (match(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, match);
    if (found !== undefined) return found;
  }
  return undefined;
}
