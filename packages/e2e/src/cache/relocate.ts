/**
 * Deterministic target relocation.
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

import type { SemanticNode } from '../engine/surface.ts';
import { containerKey, describeTarget, parentsOf } from '../agent/actions.ts';
import type { TracePosition, TraceTargetDescriptor } from './trace.ts';

/**
 * Version of the replay/relocation policy, part of every cache key. Bumping
 * it cold-starts the cache — which is exactly right when the matching rules
 * change, because an entry recorded under different rules could relocate to a
 * different node.
 */
export const REPLAY_POLICY_VERSION = 'conservative/5';

/**
 * The share of the viewport a scrolled node must have covered when it was
 * addressed (`ScrollAction.spans`) to scroll as the viewport does once it
 * cannot be re-found: scrolling the main list and scrolling the screen are
 * the same gesture, while a smaller region that vanished is gone.
 */
export const MAIN_LIST_SHARE = 0.5;

export type RelocationFailure = 'target-not-found' | 'target-ambiguous';

export type RelocationResult =
  | { readonly kind: 'found'; readonly id: string }
  | { readonly kind: 'failed'; readonly failure: 'target-not-found' }
  /** Several nodes share the matched identity; a caller with other evidence (a recorded point) may still tell them apart. */
  | { readonly kind: 'failed'; readonly failure: 'target-ambiguous'; readonly candidates: readonly string[] };

export type DescriptorField = keyof TraceTargetDescriptor;

export interface DescriptorMatchOptions {
  readonly redact: (text: string) => string;
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
/**
 * A descriptor with nothing to identify the control by: no test id, name,
 * text, or placeholder, only a role. A form built without labels is made of
 * these. Such a descriptor relocates by its place among the unnamed
 * controls of its kind, so it is relocatable only once a position was
 * recorded for it, and it is matched strictly (`fieldsIdentical`): an
 * unnamed textbox must never stand in for a named one.
 */
function isAnonymous(descriptor: TraceTargetDescriptor): boolean {
  return (
    descriptor.testId === undefined &&
    descriptor.name === undefined &&
    descriptor.text === undefined &&
    descriptor.placeholder === undefined
  );
}

function isRelocatableDescriptor(descriptor: TraceTargetDescriptor): boolean {
  return isAnonymous(descriptor) ? descriptor.role !== undefined && descriptor.position !== undefined : true;
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
  // A test id that churned is forgiven only when the semantic fields still
  // identify the node. Dropping it must not leave an anonymous descriptor: a
  // position counted among test-id twins says nothing about the unnamed
  // controls of that role, so it would relocate to an unrelated one.
  return isRelocatableDescriptor(semantic) && !isAnonymous(semantic) ? [descriptor, semantic] : [descriptor];
}

/** Every listed field the recording captured must be present and equal on the candidate. */
export function fieldsEqual(
  recorded: TraceTargetDescriptor,
  candidate: TraceTargetDescriptor,
  fields: readonly DescriptorField[],
): boolean {
  return fields.every((field) => recorded[field] === undefined || candidate[field] === recorded[field]);
}

/** Like `fieldsEqual`, but a field the recording lacks must be absent on the candidate too. */
function fieldsIdentical(
  recorded: TraceTargetDescriptor,
  candidate: TraceTargetDescriptor,
  fields: readonly DescriptorField[],
): boolean {
  return fields.every((field) => candidate[field] === recorded[field]);
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
  if (cached !== undefined && cached.redact === options.redact) return cached.described;
  const described: DescribedNode[] = [];
  for (const [id, node] of nodes) {
    const descriptor = describeTarget(node, options.redact);
    if (descriptor !== undefined) described.push({ id, descriptor });
  }
  projections.set(nodes, { redact: options.redact, described });
  return described;
}

/**
 * Relocates one descriptor against the nodes of a fresh observation, tier by
 * tier (`descriptorTiers`), each exactly-one-or-diverge. Ambiguity at any
 * tier diverges immediately: two candidates sharing the matched identity
 * cannot be told apart by waiting, and acting on either would be a guess.
 * The one exception is a recorded `position`: the recording itself found the
 * same twins and noted which one it acted on, so the same count of twins
 * resolves to the same one; any other count diverges as before.
 */
export function relocateDescriptor(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, SemanticNode>,
  options: DescriptorMatchOptions,
): RelocationResult {
  const matches = matchingIds(descriptor, nodes, options);
  if (matches.length === 0) return { kind: 'failed', failure: 'target-not-found' };
  const { position } = descriptor;
  // A lone match is the node for a descriptor with an identity. An anonymous
  // one has only its count and place: one unnamed twin where the recording
  // counted two is as likely the other field as the right one.
  if (matches.length === 1 && (!isAnonymous(descriptor) || position?.of === 1)) return { kind: 'found', id: matches[0]! };
  const positioned = position !== undefined && position.of === matches.length ? matches[position.index] : undefined;
  return positioned === undefined
    ? { kind: 'failed', failure: 'target-ambiguous', candidates: matches }
    : { kind: 'found', id: positioned };
}

/**
 * The ids a descriptor matches in a fresh observation, in document order: the
 * strictest tier (`descriptorTiers`) that matches anything decides, so a
 * churned test id still falls back to the semantic fields. Empty when nothing
 * matches. The recorder uses the same projection to notice, before it writes a
 * target, that the description alone would not tell the target from its twins.
 */
function matchingIds(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, SemanticNode>,
  options: DescriptorMatchOptions,
): readonly string[] {
  const candidates = describeNodes(nodes, options);
  // A recorded container key must hold: the same "Delete" in another row is
  // a different control. Checked against the tree the candidates came from,
  // never guessed.
  const keyed =
    descriptor.within === undefined
      ? candidates
      : (() => {
          const parents = parentsOf(nodes);
          return candidates.filter(
            (candidate) => containerKey(candidate.id, nodes, parents, options.redact) === descriptor.within,
          );
        })();
  for (const tier of descriptorTiers(descriptor)) {
    const matches = tierMatches(tier, keyed);
    if (matches.length > 0) return matches;
  }
  return [];
}

function tierMatches(tier: TraceTargetDescriptor, candidates: readonly DescribedNode[]): string[] {
  if (isAnonymous(tier)) {
    return candidates
      .filter((candidate) => fieldsIdentical(tier, candidate.descriptor, IDENTITY_FIELDS_WITH_TEXT))
      .map((candidate) => candidate.id);
  }
  const fields = tier.testId === undefined && tier.name === undefined ? IDENTITY_FIELDS_WITH_TEXT : IDENTITY_FIELDS;
  return candidates
    .filter((candidate) => fieldsEqual(tier, candidate.descriptor, fields))
    .map((candidate) => candidate.id);
}

/** Beyond this many twins a description is not a control set but a list; a position there would be noise. */
const MAX_POSITIONED_TWINS = 1000;

/**
 * Where `node` stands among the controls its own description matches on the
 * screen it was acted on, or undefined when the description already names it
 * alone. Recorded with the target so a replay can tell one "Set up" button per
 * card apart without an app change; a distinct label makes it unnecessary.
 */
export function describePosition(
  node: SemanticNode,
  within: string | undefined,
  nodes: ReadonlyMap<string, SemanticNode>,
  options: DescriptorMatchOptions,
): TracePosition | undefined {
  const described = describeTarget(node, options.redact);
  if (described === undefined || (described.role === undefined && isAnonymous(described))) return undefined;
  // An anonymous target has no identity to match alone; its position is what
  // makes it relocatable, so it is counted among its unnamed twins even when
  // it is the only one, and described with a placeholder position to do so.
  const anonymous = isAnonymous(described);
  const probe = { ...described, ...(within === undefined ? {} : { within }), ...(anonymous ? { position: { index: 0, of: 1 } } : {}) };
  const ids = matchingIds(probe, nodes, options);
  if (ids.length < (anonymous ? 1 : 2) || ids.length > MAX_POSITIONED_TWINS) return undefined;
  const index = ids.indexOf(node.ref.id);
  return index === -1 ? undefined : { index, of: ids.length };
}
