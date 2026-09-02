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
 * make a node unequal to its own recording.
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
export const REPLAY_POLICY_VERSION = 'conservative/2';

export type RelocationFailure = 'target-not-found' | 'target-ambiguous';

export type RelocationResult =
  | { readonly kind: 'found'; readonly id: string }
  | { readonly kind: 'failed'; readonly failure: RelocationFailure };

/** Identity fields that must match whenever the recording captured them. */
const IDENTITY_FIELDS = ['role', 'name', 'testId', 'placeholder', 'inputPurpose'] as const;

/**
 * Relocates one descriptor against the nodes of a fresh observation, in two
 * tiers, each exactly-one-or-diverge:
 *
 * 1. **Strict** — every identity field the recording captured must match.
 * 2. **Semantic** — only when strict found nothing and a `testId` was
 *    recorded: the same match without it. Test ids are the strongest
 *    discriminator when stable, but some apps mint them per render; a node
 *    the semantic fields still identify uniquely has not moved, its label
 *    has not changed, and refusing it would diverge on cosmetics.
 *
 * Ambiguity at either tier diverges immediately: two candidates sharing the
 * matched identity cannot be told apart by waiting, and acting on either
 * would be a guess.
 */
export function relocateDescriptor(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, SemanticNode>,
  options: RelocationOptions,
): RelocationResult {
  const candidates = projectNodes(nodes, options);
  const strict = matchDescriptor(descriptor, candidates);
  if (strict.kind === 'found' || strict.failure === 'target-ambiguous') return strict;
  if (descriptor.testId === undefined) return strict;
  const { testId, ...semantic } = descriptor;
  void testId;
  return matchDescriptor(semantic, candidates);
}

export interface RelocationOptions {
  readonly redact: (text: string) => string;
  readonly testIdAttribute: string;
}

type ProjectedNodes = ReadonlyMap<string, TraceTargetDescriptor | undefined>;

interface Projection extends RelocationOptions {
  readonly projected: ProjectedNodes;
}

/**
 * Descriptor projections per observation. A replay relocates every recorded
 * action, in two tiers, against the same node map (and again per settling
 * retry), while the projection of a node is a pure function of the node: it
 * is computed once per observation and shared by every lookup into it.
 */
const projections = new WeakMap<ReadonlyMap<string, SemanticNode>, Projection>();

function projectNodes(
  nodes: ReadonlyMap<string, SemanticNode>,
  options: RelocationOptions,
): ProjectedNodes {
  const cached = projections.get(nodes);
  if (
    cached !== undefined &&
    cached.redact === options.redact &&
    cached.testIdAttribute === options.testIdAttribute
  ) {
    return cached.projected;
  }
  const projected = new Map<string, TraceTargetDescriptor | undefined>();
  for (const [id, node] of nodes) {
    projected.set(id, describeTarget(node, options.redact, options.testIdAttribute));
  }
  projections.set(nodes, { ...options, projected });
  return projected;
}

function matchDescriptor(
  descriptor: TraceTargetDescriptor,
  candidates: ProjectedNodes,
): RelocationResult {
  const requireText = descriptor.testId === undefined && descriptor.name === undefined;
  if (requireText && descriptor.text === undefined && descriptor.placeholder === undefined) {
    // Role or selector alone cannot identify a node; a wrong match acts on
    // the wrong control, so this descriptor is not relocatable at all.
    return { kind: 'failed', failure: 'target-not-found' };
  }
  const matches: string[] = [];
  for (const [id, candidate] of candidates) {
    if (candidate === undefined) continue;
    if (!fieldsMatch(descriptor, candidate, requireText)) continue;
    matches.push(id);
    if (matches.length > 1) return { kind: 'failed', failure: 'target-ambiguous' };
  }
  const only = matches[0];
  if (only === undefined) return { kind: 'failed', failure: 'target-not-found' };
  return { kind: 'found', id: only };
}

function fieldsMatch(
  descriptor: TraceTargetDescriptor,
  candidate: TraceTargetDescriptor,
  requireText: boolean,
): boolean {
  for (const field of IDENTITY_FIELDS) {
    const recorded = descriptor[field];
    if (recorded !== undefined && candidate[field] !== recorded) return false;
  }
  if (requireText && descriptor.text !== undefined && candidate.text !== descriptor.text) {
    return false;
  }
  return true;
}
