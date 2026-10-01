/** Fixture nodes in the redacted shape descriptors, anchors, and relocation read. */

import { redactNode, type NodeRedaction, type RedactedNode } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';

/** Redaction that changes nothing: the fixture holds no registered secret. */
const NO_SECRETS: NodeRedaction = { redact: (text) => text, redactCut: (text) => text };

/** One fixture node as an observation would hand it on, redacted through `redaction`. */
export function redacted(node: SemanticNode, redaction: NodeRedaction = NO_SECRETS): RedactedNode {
  return redactNode(node, redaction);
}

/** Fixture nodes by id, each redacted as `redacted` does. */
export function redactedNodes(list: readonly SemanticNode[], redaction: NodeRedaction = NO_SECRETS): Map<string, RedactedNode> {
  return new Map(list.map((node) => [node.ref.id, redacted(node, redaction)]));
}
