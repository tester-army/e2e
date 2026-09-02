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
 * are the step's own delta, compared through the same projection replay
 * relocates targets by, so a replay must reproduce the recorded effect — not
 * just the recorded clicks — before it may pass on its own.
 */

import type { SemanticNode } from '../backend/surface.ts';
import { describeTarget } from '../agent/actions.ts';
import { isRelocatableDescriptor } from './relocate.ts';
import { MAX_TRACE_ANCHORS, type TraceTargetDescriptor } from './trace.ts';

export interface AnchorOptions {
  readonly redact: (text: string) => string;
  readonly testIdAttribute: string;
}

/**
 * Derives the end anchors of one step: relocatable descriptors present in the
 * passing observation and absent from the starting one, deduplicated, capped.
 * Leaves come first, then containers, each in document order: a container's
 * accessible name is usually the concatenation of its children's, so it
 * repeats what the leaves already say — and on a list-heavy screen those
 * repeats would crowd the one status line that names the effect out of the
 * cap. The structural selector is dropped — anchors ask whether an effect is
 * visible, never where it sits in the document.
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
 * Whether one anchor is present in a fresh observation. Unlike target
 * relocation, every recorded field must match — text included, whenever the
 * anchor has any: for a target, text is a fallback identity and a relabeled
 * button is still the button, but for an anchor the text *is* the effect (a
 * status reading "saved" rather than "empty"), so a looser match would pass a
 * step whose save never took. Presence, not uniqueness: two matching nodes
 * are the effect twice over. A recorded test id that churned per render is
 * forgiven when the remaining fields still identify the node — the same
 * concession relocation makes, for the same reason.
 */
export function anchorPresent(
  anchor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, SemanticNode>,
  options: AnchorOptions,
): boolean {
  const candidates: TraceTargetDescriptor[] = [];
  for (const node of nodes.values()) {
    const descriptor = anchorDescriptor(node, options);
    if (descriptor !== undefined) candidates.push(descriptor);
  }
  if (candidates.some((candidate) => fieldsEqual(anchor, candidate))) return true;
  if (anchor.testId === undefined) return false;
  const { testId, ...semantic } = anchor;
  void testId;
  if (!isRelocatableDescriptor(semantic)) return false;
  return candidates.some((candidate) => fieldsEqual(semantic, candidate));
}

const ANCHOR_FIELDS = ['role', 'name', 'text', 'testId', 'placeholder', 'inputPurpose'] as const;

/** Every field the anchor recorded must be present and equal on the candidate. */
function fieldsEqual(anchor: TraceTargetDescriptor, candidate: TraceTargetDescriptor): boolean {
  return ANCHOR_FIELDS.every(
    (field) => anchor[field] === undefined || candidate[field] === anchor[field],
  );
}

/** One node's anchor projection, or undefined when it could identify nothing. */
function anchorDescriptor(
  node: SemanticNode,
  options: AnchorOptions,
): TraceTargetDescriptor | undefined {
  const described = describeTarget(node, options.redact, options.testIdAttribute);
  if (described === undefined || !isRelocatableDescriptor(described)) return undefined;
  const { selector, ...anchor } = described;
  void selector;
  return anchor;
}

/**
 * Set key for one descriptor: field order is fixed, so equal descriptors share
 * a key. The test id is left out whenever the other fields identify the node:
 * an app that mints test ids per render would otherwise make every unchanged
 * control look new after a re-render, and the noise would crowd the real
 * effect out of the capped anchor list. A node only a test id identifies
 * keeps it — without it the key would be empty.
 */
function anchorKey(descriptor: TraceTargetDescriptor): string {
  const { testId, ...semantic } = descriptor;
  return JSON.stringify([
    descriptor.role,
    descriptor.name,
    descriptor.text,
    isRelocatableDescriptor(semantic) ? undefined : testId,
    descriptor.placeholder,
    descriptor.inputPurpose,
  ]);
}
