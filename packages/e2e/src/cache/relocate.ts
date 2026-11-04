/**
 * Deterministic target relocation.
 *
 * Re-finds a recorded target descriptor in a fresh observation: exactly one
 * node must match, or replay diverges. This is the conservative public
 * ReplayPolicy — no scoring, no vision, no fuzzy matching beyond reading a
 * minted test id by its shape (`descriptorTiers`). A tuned policy may
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

import type { RedactedNode } from '../agent/observation.ts';
import { containerKey, describeTarget, parentsOf } from '../agent/actions.ts';
import type { TracePosition, TraceTargetDescriptor } from './trace.ts';

/**
 * Version of the replay/relocation policy, part of every cache key. Bumping
 * it cold-starts the cache — which is exactly right when the matching rules
 * change, because an entry recorded under different rules could relocate to a
 * different node.
 */
export const REPLAY_POLICY_VERSION = 'conservative/6';

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

/** A node's descriptor projection alongside its per-observation id. */
interface DescribedNode {
  readonly id: string;
  readonly descriptor: TraceTargetDescriptor;
}

/** Identity fields that must match whenever the recording captured them. */
const IDENTITY_FIELDS: readonly DescriptorField[] = ['role', 'name', 'testId', 'placeholder', 'inputPurpose'];

/** Text is identity too when neither a test id nor a name was recorded. */
const IDENTITY_FIELDS_WITH_TEXT: readonly DescriptorField[] = [...IDENTITY_FIELDS, 'text'];

/**
 * A descriptor with nothing to identify the control by: no test id, name,
 * text, or placeholder, only a role. An icon button and a form built
 * without labels are made of these. Such a descriptor relocates by its place
 * among the unnamed controls of its kind, and it is matched strictly
 * (`fieldsIdentical`): an unnamed textbox must never stand in for a named
 * one.
 */
function isAnonymous(descriptor: TraceTargetDescriptor): boolean {
  return (
    descriptor.testId === undefined &&
    descriptor.name === undefined &&
    descriptor.text === undefined &&
    descriptor.placeholder === undefined
  );
}

/**
 * Whether a descriptor can identify a node at all. Role or selector alone
 * cannot: a wrong match acts on the wrong control, so such a descriptor is
 * not relocatable and, as an anchor, would prove nothing. An anonymous one
 * is relocatable by its recorded place only when that place means something
 * on the next screen: it was the one unnamed control of its role, or it sits
 * in a named container (`within`) that tells it from its twins. A place
 * counted among twins with no container is an order, and rows that reorder
 * would hand the action to the wrong one, so such a target hands off.
 */
export function isRelocatableDescriptor(descriptor: TraceTargetDescriptor): boolean {
  return !isAnonymous(descriptor) || (descriptor.role !== undefined && isPlaced(descriptor));
}

/** Whether a recorded place tells the target apart: it was counted alone, or sits in a named container. */
function isPlaced(descriptor: TraceTargetDescriptor): boolean {
  const { position } = descriptor;
  return position !== undefined && (position.of === 1 || descriptor.within !== undefined);
}

/** The semantic tier of a descriptor: every identity field but the test id. */
function withoutTestId(descriptor: TraceTargetDescriptor): TraceTargetDescriptor {
  const { testId: _testId, ...semantic } = descriptor;
  return semantic;
}

/**
 * One rung of the matching ladder (`descriptorTiers`): the fields it
 * compares, and how it reads a candidate (`tierView`).
 */
export interface DescriptorTier {
  readonly kind: 'strict' | 'semantic' | 'shape';
  readonly descriptor: TraceTargetDescriptor;
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
 * 3. **Shape** — only when the test id is all that identifies the node and
 *    holds a minted part: the test id with each such part read as `#`
 *    (`rf__node-#`, `row-#-delete`), compared with candidates read the same
 *    way. A shape names no node alone, so a target matches by it only where
 *    a place means something (`relocateDescriptor`).
 *
 * Empty for a descriptor that identifies nothing.
 */
export function descriptorTiers(descriptor: TraceTargetDescriptor): readonly DescriptorTier[] {
  if (!isRelocatableDescriptor(descriptor)) return [];
  const strict: DescriptorTier = { kind: 'strict', descriptor };
  if (descriptor.testId === undefined) return [strict];
  const semantic = withoutTestId(descriptor);
  // A test id that churned is forgiven only when the semantic fields still
  // identify the node. Dropping it must not leave an anonymous descriptor: a
  // position counted among test-id twins says nothing about the unnamed
  // controls of that role, so it would relocate to an unrelated one.
  if (isRelocatableDescriptor(semantic) && !isAnonymous(semantic)) return [strict, { kind: 'semantic', descriptor: semantic }];
  const shape = testIdShape(descriptor.testId);
  return shape === undefined ? [strict] : [strict, { kind: 'shape', descriptor: { ...descriptor, testId: shape } }];
}

/** A candidate as a tier compares it: as described, or by its test id shape, undefined when it has none. */
export function tierView(tier: DescriptorTier, candidate: TraceTargetDescriptor): TraceTargetDescriptor | undefined {
  if (tier.kind !== 'shape') return candidate;
  return descriptorTiers(candidate).find((rung) => rung.kind === 'shape')?.descriptor;
}

/** Whether a tier tells nodes apart only by their count and place: an unnamed control, or a test id shape. */
function matchesByPlace(tier: DescriptorTier): boolean {
  return tier.kind === 'shape' || isAnonymous(tier.descriptor);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A test id part an app mints: a hex id or hash, a cuid, a recent epoch time in seconds or milliseconds. */
const MINTED_TEST_ID_PART: readonly RegExp[] = [
  /^(?=.*\d)(?=.*[a-f])[0-9a-f]{8,}$/i,
  /^(?=(?:\D*\d){2})(?=.*[A-Za-z])[A-Za-z0-9]{8,}$/,
  /^1[5-9]\d{8}(?:\d{3})?$/,
];

/** The test id with each uuid and minted part read as `#`, undefined when it has none. */
function testIdShape(testId: string): string | undefined {
  const shape = testId
    .replace(UUID, '#')
    .split(/([-_:./]+)/)
    .map((part, index) => (index % 2 === 0 && MINTED_TEST_ID_PART.some((pattern) => pattern.test(part)) ? '#' : part))
    .join('');
  return shape === testId ? undefined : shape;
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

/**
 * Descriptor projections per observation. A replay relocates every recorded
 * action, in two tiers, against the same node map (and again per settling
 * retry), and the anchor check projects it once more, while the projection of
 * a node is a pure function of the node: it is computed once per observation
 * and shared by every lookup into it.
 */
const projections = new WeakMap<ReadonlyMap<string, RedactedNode>, readonly DescribedNode[]>();

/** Projects every node of an observation the way the recorder described its targets. */
function describeNodes(nodes: ReadonlyMap<string, RedactedNode>): readonly DescribedNode[] {
  const cached = projections.get(nodes);
  if (cached !== undefined) return cached;
  const described: DescribedNode[] = [];
  for (const [id, node] of nodes) {
    const descriptor = describeTarget(node);
    if (descriptor !== undefined) described.push({ id, descriptor });
  }
  projections.set(nodes, described);
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
  nodes: ReadonlyMap<string, RedactedNode>,
): RelocationResult {
  const { ids: matches, tier } = matchingIds(descriptor, nodes);
  if (tier === undefined) return { kind: 'failed', failure: 'target-not-found' };
  const { position } = descriptor;
  // A lone match is the node for a tier with an identity. One that matches
  // by place has only the count: one twin where the recording counted two is
  // as likely the other one.
  if (matches.length === 1 && (!matchesByPlace(tier) || position?.of === 1)) return { kind: 'found', id: matches[0]! };
  const positioned = position !== undefined && position.of === matches.length ? matches[position.index] : undefined;
  return positioned === undefined
    ? { kind: 'failed', failure: 'target-ambiguous', candidates: matches }
    : { kind: 'found', id: positioned };
}

/**
 * The ids a descriptor matches in a fresh observation, in document order, and
 * the tier that matched: the strictest tier (`descriptorTiers`) that matches
 * anything decides, so a churned test id still falls back to the semantic
 * fields, and a minted one to its shape. No tier when nothing matches. The
 * recorder uses the same projection to notice, before it writes a target,
 * that the description alone would not tell the target from its twins.
 */
function matchingIds(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, RedactedNode>,
): { readonly ids: readonly string[]; readonly tier?: DescriptorTier } {
  const keyed = candidatesWithin(descriptor.within, nodes);
  for (const tier of descriptorTiers(descriptor)) {
    // A shape is tried only where a place means something, as for an unnamed
    // control: alone when recorded (`describePosition`), or in a named container.
    if (tier.kind === 'shape' && !isPlaced(descriptor)) continue;
    const matches = tierMatches(tier, keyed);
    if (matches.length > 0) return { ids: matches, tier };
  }
  return { ids: [] };
}

/** The candidates in the recorded container. */
function candidatesWithin(within: string | undefined, nodes: ReadonlyMap<string, RedactedNode>): readonly DescribedNode[] {
  const candidates = describeNodes(nodes);
  if (within === undefined) return candidates;
  // A recorded container key must hold: the same "Delete" in another row is
  // a different control. Checked against the tree the candidates came from,
  // never guessed.
  const parents = parentsOf(nodes);
  return candidates.filter((candidate) => containerKey(candidate.id, nodes, parents) === within);
}

function tierMatches(tier: DescriptorTier, candidates: readonly DescribedNode[]): string[] {
  const recorded = tier.descriptor;
  const equal = isAnonymous(recorded) ? fieldsIdentical : fieldsEqual;
  const fields = recorded.testId === undefined && recorded.name === undefined ? IDENTITY_FIELDS_WITH_TEXT : IDENTITY_FIELDS;
  return candidates
    .filter((candidate) => {
      const view = tierView(tier, candidate.descriptor);
      return view !== undefined && equal(recorded, view, fields);
    })
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
  node: RedactedNode,
  within: string | undefined,
  nodes: ReadonlyMap<string, RedactedNode>,
): TracePosition | undefined {
  const described = describeTarget(node);
  if (described === undefined || (described.role === undefined && isAnonymous(described))) return undefined;
  // A target whose loosest tier matches by place, an unnamed control or a
  // test id shape, has no identity to match alone; its position is what
  // makes it relocatable, so it is counted among its twins on that tier even
  // when it is the only one, and described with a placeholder position to do so.
  const probe = { ...described, ...(within === undefined ? {} : { within }), position: { index: 0, of: 1 } };
  const tiers = descriptorTiers(probe);
  const loosest = tiers[tiers.length - 1];
  if (loosest === undefined) return undefined;
  const byPlace = matchesByPlace(loosest);
  const ids = byPlace ? tierMatches(loosest, candidatesWithin(within, nodes)) : matchingIds(probe, nodes).ids;
  if (ids.length < (byPlace ? 1 : 2) || ids.length > MAX_POSITIONED_TWINS) return undefined;
  const index = ids.indexOf(node.ref.id);
  return index === -1 ? undefined : { index, of: ids.length };
}
