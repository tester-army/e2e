/**
 * End anchors (RFC0001 layer 3, cache-in decision).
 *
 * A recording run does not end when its last action commits; it ends when the
 * executor looks at the screen and judges the step done. The trace used to
 * keep only the actions and drop that look, so a replay could run every
 * recorded action mechanically — a fill that never committed, a save that
 * produced an unnamed record — and self-finalize with nothing checking the
 * effect. Anchors restore the check as data: the descriptors of nodes that
 * were on screen when the step passed and were not there when it began. They
 * are the step's own delta, checked by the relocation vocabulary
 * (`relocate.ts`) with two deliberate differences: every recorded field must
 * be equal, text included, and presence is enough — uniqueness is not asked.
 */

import type { SemanticNode } from '../engine/surface.ts';
import { describeTarget } from '../agent/actions.ts';
import {
  describeNodes,
  descriptorTiers,
  fieldsEqual,
  type DescriptorField,
  type DescriptorMatchOptions,
} from './relocate.ts';
import { MAX_TRACE_ANCHORS, type TraceTargetDescriptor } from './trace.ts';

export type AnchorOptions = DescriptorMatchOptions;

/**
 * Every field an anchor records. Unlike target relocation, text is never
 * optional here: for a target, text is a fallback identity and a relabeled
 * button is still the button, but for an anchor the text *is* the effect (a
 * status reading "saved" rather than "empty"), so a looser match would pass a
 * step whose save never took. The structural selector is left out — anchors
 * ask whether an effect is visible, never where it sits in the document.
 */
const ANCHOR_FIELDS: readonly DescriptorField[] = ['role', 'name', 'text', 'testId', 'placeholder', 'inputPurpose'];

/**
 * Derives the end anchors of one step: relocatable descriptors present in the
 * passing observation and absent from the starting one, deduplicated, capped.
 * Leaves come first, then containers, each in document order: a container's
 * accessible name is usually the concatenation of its children's, so it
 * repeats what the leaves already say — and on a list-heavy screen those
 * repeats would crowd the one status line that names the effect out of the
 * cap.
 */
export function describeAnchors(
  startNodes: ReadonlyMap<string, SemanticNode>,
  endNodes: ReadonlyMap<string, SemanticNode>,
  options: AnchorOptions,
): TraceTargetDescriptor[] {
  const before = new Set<string>();
  for (const node of startNodes.values()) {
    const descriptor = anchorDescriptor(node, options);
    if (descriptor !== undefined) before.add(anchorKey(descriptor));
  }
  const seen = new Set<string>();
  const leaves: TraceTargetDescriptor[] = [];
  const containers: TraceTargetDescriptor[] = [];
  for (const node of endNodes.values()) {
    const descriptor = anchorDescriptor(node, options);
    if (descriptor === undefined) continue;
    const key = anchorKey(descriptor);
    if (before.has(key) || seen.has(key)) continue;
    seen.add(key);
    (node.children === undefined || node.children.length === 0 ? leaves : containers).push(descriptor);
  }
  return [...leaves, ...containers].slice(0, MAX_TRACE_ANCHORS);
}

/**
 * Whether every anchor is present in a fresh observation: some tier of the
 * anchor (`descriptorTiers` — so a test id that churned per render is
 * forgiven when the remaining fields still identify the node) equals some
 * candidate on every anchor field. Two matching nodes are the effect twice
 * over, not an ambiguity.
 */
export function anchorsPresent(
  anchors: readonly TraceTargetDescriptor[],
  nodes: ReadonlyMap<string, SemanticNode>,
  options: AnchorOptions,
): boolean {
  const candidates = describeNodes(nodes, options).map((node) => node.descriptor);
  return anchors.every((anchor) =>
    descriptorTiers(anchor).some((tier) =>
      candidates.some((candidate) => fieldsEqual(tier, candidate, ANCHOR_FIELDS)),
    ),
  );
}

/** One node's anchor projection, or undefined when it could identify nothing. */
function anchorDescriptor(node: SemanticNode, options: AnchorOptions): TraceTargetDescriptor | undefined {
  const described = describeTarget(node, options.redact, options.testIdAttribute);
  if (described === undefined || descriptorTiers(described).length === 0) return undefined;
  const { selector: _selector, ...anchor } = described;
  return anchor;
}

/**
 * Set key for one descriptor: its loosest identifying tier over the anchor
 * fields, in fixed order. Keying on the semantic tier whenever it identifies
 * the node means an app that mints test ids per render cannot make every
 * unchanged control look new after a re-render and crowd the real effect out
 * of the capped list; a node only a test id identifies keeps it.
 */
function anchorKey(descriptor: TraceTargetDescriptor): string {
  const tiers = descriptorTiers(descriptor);
  const loosest = tiers[tiers.length - 1] ?? descriptor;
  return JSON.stringify(ANCHOR_FIELDS.map((field) => loosest[field]));
}
