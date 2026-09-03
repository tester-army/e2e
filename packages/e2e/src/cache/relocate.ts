/**
 * Deterministic target relocation (RFC0001 layer 3, cache-in decision).
 *
 * Re-finds a recorded target descriptor in a fresh observation: exactly one
 * node must match, or replay diverges. This is the conservative public
 * ReplayPolicy — no scoring, no fuzzy matching, no vision. A tuned policy may
 * replace it behind the same seam; the fail-closed contract (one match or
 * hand off) is not tunable.
 *
 * Candidates are compared through the same `describeTarget` projection the
 * recorder used, so redaction, whitespace collapsing, and bounding cannot
 * make a node unequal to its own recording. The matching vocabulary — which
 * tiers a descriptor is tried in, and what "equal on the recorded fields"
 * means — is exported so end anchors (`anchors.ts`) are checked by the same
 * rules and can never drift from relocation.
 */

import type { SemanticNode } from '../backend/surface.ts';
import { describeTarget } from '../agent/actions.ts';
import type { TraceTargetDescriptor } from './trace.ts';

/**
 * Version of the replay/relocation policy, part of every cache key. Bumping
 * it cold-starts the cache — which is exactly right when the matching rules
 * change, because an entry recorded under different rules could relocate to a
 * different node.
 */
export const REPLAY_POLICY_VERSION = 'conservative/3';

export type RelocationFailure = 'target-not-found' | 'target-ambiguous';

export type RelocationResult =
  | { readonly kind: 'found'; readonly id: string }
  | { readonly kind: 'failed'; readonly failure: RelocationFailure };

export type DescriptorField = keyof TraceTargetDescriptor;

export interface DescriptorMatchOptions {
  readonly redact: (text: string) => string;
  readonly testIdAttribute: string;
}

/** A node's descriptor projection alongside its per-observation id. */
export interface DescribedNode {
  readonly id: string;
  readonly descriptor: TraceTargetDescriptor;
}

/** Identity fields that must match whenever the recording captured them. */
const IDENTITY_FIELDS: readonly DescriptorField[] = ['role', 'name', 'testId', 'placeholder', 'inputPurpose'];

/** Text is identity too when neither a test id nor a name was recorded. */
const IDENTITY_FIELDS_WITH_TEXT: readonly DescriptorField[] = [...IDENTITY_FIELDS, 'text'];

/**
 * Whether a descriptor can identify a node at all. Role or selector alone
 * cannot: a wrong match acts on the wrong control, so such a descriptor is
 * not relocatable and, as an anchor, would prove nothing.
 */
function isRelocatableDescriptor(descriptor: TraceTargetDescriptor): boolean {
  return (
    descriptor.testId !== undefined ||
    descriptor.name !== undefined ||
    descriptor.text !== undefined ||
    descriptor.placeholder !== undefined
  );
}

/** The semantic tier of a descriptor: every identity field but the test id. */
function withoutTestId(descriptor: TraceTargetDescriptor): TraceTargetDescriptor {
  const { testId: _testId, ...semantic } = descriptor;
  return semantic;
}

/**
 * The tiers a recorded descriptor is matched in, strictest first:
 *
 * 1. **Strict** — every identity field the recording captured must match.
 * 2. **Semantic** — only when a `testId` was recorded and the remaining
 *    fields still identify the node: the same descriptor without it. Test
 *    ids are the strongest discriminator when stable, but some apps mint
 *    them per render; a node the semantic fields still identify has not
 *    moved, its label has not changed, and refusing it would fail on
 *    cosmetics.
 *
 * Empty for a descriptor that identifies nothing.
 */
export function descriptorTiers(descriptor: TraceTargetDescriptor): readonly TraceTargetDescriptor[] {
  if (!isRelocatableDescriptor(descriptor)) return [];
  if (descriptor.testId === undefined) return [descriptor];
  const semantic = withoutTestId(descriptor);
  return isRelocatableDescriptor(semantic) ? [descriptor, semantic] : [descriptor];
}

/** Every listed field the recording captured must be present and equal on the candidate. */
export function fieldsEqual(
  recorded: TraceTargetDescriptor,
  candidate: TraceTargetDescriptor,
  fields: readonly DescriptorField[],
): boolean {
  return fields.every((field) => recorded[field] === undefined || candidate[field] === recorded[field]);
}

interface Projection extends DescriptorMatchOptions {
  readonly described: readonly DescribedNode[];
}

/**
 * Descriptor projections per observation. A replay relocates every recorded
 * action, in two tiers, against the same node map (and again per settling
 * retry), and the anchor check projects it once more, while the projection of
 * a node is a pure function of the node: it is computed once per observation
 * and shared by every lookup into it.
 */
const projections = new WeakMap<ReadonlyMap<string, SemanticNode>, Projection>();

/** Projects every node of an observation the way the recorder described its targets. */
export function describeNodes(
  nodes: ReadonlyMap<string, SemanticNode>,
  options: DescriptorMatchOptions,
): readonly DescribedNode[] {
  const cached = projections.get(nodes);
  if (
    cached !== undefined &&
    cached.redact === options.redact &&
    cached.testIdAttribute === options.testIdAttribute
  ) {
    return cached.described;
  }
  const described: DescribedNode[] = [];
  for (const [id, node] of nodes) {
    const descriptor = describeTarget(node, options.redact, options.testIdAttribute);
    if (descriptor !== undefined) described.push({ id, descriptor });
  }
  projections.set(nodes, { redact: options.redact, testIdAttribute: options.testIdAttribute, described });
  return described;
}

/**
 * Relocates one descriptor against the nodes of a fresh observation, tier by
 * tier (`descriptorTiers`), each exactly-one-or-diverge. Ambiguity at any
 * tier diverges immediately: two candidates sharing the matched identity
 * cannot be told apart by waiting, and acting on either would be a guess.
 */
export function relocateDescriptor(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, SemanticNode>,
  options: DescriptorMatchOptions,
): RelocationResult {
  const candidates = describeNodes(nodes, options);
  for (const tier of descriptorTiers(descriptor)) {
    const result = matchTier(tier, candidates);
    if (result.kind === 'found' || result.failure === 'target-ambiguous') return result;
  }
  return { kind: 'failed', failure: 'target-not-found' };
}

function matchTier(tier: TraceTargetDescriptor, candidates: readonly DescribedNode[]): RelocationResult {
  const fields = tier.testId === undefined && tier.name === undefined ? IDENTITY_FIELDS_WITH_TEXT : IDENTITY_FIELDS;
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (!fieldsEqual(tier, candidate.descriptor, fields)) continue;
    matches.push(candidate.id);
    if (matches.length > 1) return { kind: 'failed', failure: 'target-ambiguous' };
  }
  const only = matches[0];
  if (only === undefined) return { kind: 'failed', failure: 'target-not-found' };
  return { kind: 'found', id: only };
}
