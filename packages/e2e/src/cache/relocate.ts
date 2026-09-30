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
 * make a node unequal to its own recording. The matching vocabulary — the
 * fields a test id or a label identifies a node by, and how labels are
 * compared — is exported so end anchors (`anchors.ts`) are checked by the
 * same rules and can never drift from relocation.
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
export const REPLAY_POLICY_VERSION = 'conservative/7';

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

/**
 * The identities a control is relocated by, strongest first: what the app
 * named it for tests, then the element id its author wrote. Either is the
 * control's own stable handle, and what it says plays no part: a label in
 * many apps carries state (`Like (0 likes)`, a row named after its contents
 * and age). Twins sharing an id resolve by the recorded position, never by
 * whichever label happens to match now.
 */
const ID_FIELDS: readonly ('testId' | 'elementId')[] = ['testId', 'elementId'];

/** What a control is apart from any id: the fields a label-matched tier compares verbatim. */
export const SEMANTIC_ID_FIELDS: readonly DescriptorField[] = ['role', 'placeholder', 'inputPurpose'];

/** Every field a descriptor can carry as identity; an anonymous descriptor must equal a candidate on all of them. */
const ALL_IDENTITY_FIELDS: readonly DescriptorField[] = ['role', 'name', 'text', 'testId', 'elementId', 'placeholder', 'inputPurpose'];

/** The fields a control is labelled by. Text counts only when no name was recorded: a relabeled button is still the button. */
export type LabelField = 'name' | 'text';

/**
 * A relative time word: the part of a label a calendar moves. `now` counts
 * only as a time of its own, at an edge of the label or beside a separator
 * (`Bob · now`), never as the adverb of `Buy now`.
 */
export const RELATIVE_TIME = /\bjust\s+now\b|(?<=^|[^\w\s]\s*)now(?=\s*(?:$|[^\w\s]))|\b(?:today|yesterday|tomorrow)\b/i;
/**
 * A count with a unit of time, `2m`, `3 days`: the part of a label a clock
 * moves. A one-letter unit is lower case only; `3 M` is a size, not minutes.
 */
export const AGE =
  /\b\d+\s*(?:ms|[smhdwy]|mo|[Ss]ecs?|[Ss]econds?|[Mm]ins?|[Mm]inutes?|[Hh]rs?|[Hh]ours?|[Dd]ays?|[Ww]eeks?|[Mm]onths?|[Yy]ears?)\b/;
const RELATIVE_TIME_ALL = new RegExp(RELATIVE_TIME.source, 'gi');
const AGE_ALL = new RegExp(AGE.source, 'g');

/**
 * What a label fold takes out: `times` the relative times and ages only, the
 * part a clock moves on its own; `counts` also every tally, a count governing
 * a noun. Relocation folds counts, since a control's label often carries the
 * tally of the thing it acts on; an end anchor never does, since a count that
 * moved is usually the very effect the anchor stands for.
 */
export type LabelFold = 'times' | 'counts';

/**
 * A label with the state it carries taken out. A relative time or an age
 * reads `<age>`; with `counts`, a count governing a noun (`0 replies`,
 * `3 followers`) reads `#` and the noun is reduced to a stem its singular and
 * plural share (`reply`/`replies`, `movie`/`movies`, `match`/`matches`), so
 * `Reply (0 replies)` and `Reply (1 reply)` are the same shape. A number
 * that names rather than counts, `Page 2`, `Order #1234`, `Option 2`,
 * `$19.99`, `Count: 1`, stays as it reads: two such labels are two controls.
 * Case and whitespace are folded too. A label that carries no state is its
 * own shape.
 */
export function labelShape(label: string, fold: LabelFold = 'counts'): string {
  // Times fold before the case does: `3 M` is a size, `3 m` an age.
  const timed = label.replace(RELATIVE_TIME_ALL, '<age>').replace(AGE_ALL, '<age>').toLowerCase();
  const counted =
    fold === 'counts'
      ? timed.replace(/\b\d+(\s+)([a-z]{3,})\b/g, (_match, space: string, noun: string) => `#${space}${countedStem(noun)}`)
      : timed;
  return counted.replace(/\s+/g, ' ').trim();
}

/**
 * The stem a counted noun shares with its plural: an `-es` after a sibilant
 * dropped (`matches`, `boxes`, `buses`), else a trailing `s`, then `ie` and
 * `y` endings folded to `i`.
 */
function countedStem(noun: string): string {
  const singular = /(?:[sxz]|[cs]h)es$/.test(noun) ? noun.slice(0, -2) : noun.length > 3 && noun.endsWith('s') ? noun.slice(0, -1) : noun;
  return singular.replace(/(?:ie|y)$/, 'i');
}

/**
 * Whether a label reads as nothing but a time. Such a label's shape says only
 * that it is a time, so the label itself is compared: a stamp left at `now`
 * must not pass as the recorded `2m`.
 */
function isBareState(shape: string): boolean {
  return shape === '<age>';
}

/** Whether two optional labels share a shape; both absent counts, one absent does not. A bare time compares exactly. */
function sameShape(recorded: string | undefined, candidate: string | undefined, fold: LabelFold): boolean {
  if (recorded === undefined || candidate === undefined) return recorded === candidate;
  const shape = labelShape(recorded, fold);
  if (shape !== labelShape(candidate, fold)) return false;
  return isBareState(shape) ? recorded.trim() === candidate.trim() : true;
}

/** Whether the candidate's labels read as the recording's on every listed field, by shape under `fold`; an exact label is its own shape. */
export function sameLabels(
  recorded: TraceTargetDescriptor,
  candidate: TraceTargetDescriptor,
  fields: readonly LabelField[],
  fold: LabelFold,
): boolean {
  return fields.every((field) => sameShape(recorded[field], candidate[field], fold));
}

/**
 * A descriptor with nothing to identify the control by: no test id, name,
 * text, or placeholder, only a role. A form built without labels is made of
 * these. Such a descriptor relocates by its place among the unnamed
 * controls of its kind, so it is relocatable only once a position was
 * recorded for it, and it is matched strictly (`fieldsIdentical`): an
 * unnamed textbox must never stand in for a named one.
 */
export function isAnonymous(descriptor: TraceTargetDescriptor): boolean {
  return (
    descriptor.testId === undefined &&
    descriptor.elementId === undefined &&
    descriptor.name === undefined &&
    descriptor.text === undefined &&
    descriptor.placeholder === undefined
  );
}

/**
 * Whether a descriptor can identify a node at all. Role or selector alone
 * cannot: a wrong match acts on the wrong control, so such a descriptor is
 * not relocatable and, as an anchor, would prove nothing.
 */
export function isRelocatableDescriptor(descriptor: TraceTargetDescriptor): boolean {
  return isAnonymous(descriptor) ? descriptor.role !== undefined && descriptor.position !== undefined : true;
}

/** The descriptor without its ids: what is left to match by when they churned. */
export function withoutIds(descriptor: TraceTargetDescriptor): TraceTargetDescriptor {
  const { testId: _testId, elementId: _elementId, ...semantic } = descriptor;
  return semantic;
}

/**
 * The descriptor a node is keyed on across re-renders: without its test id
 * when the rest still identifies the node, so an app that mints ids per
 * render cannot make an unchanged control look new; a node only its id
 * identifies keeps it.
 */
export function identifyingProjection(descriptor: TraceTargetDescriptor): TraceTargetDescriptor {
  const semantic = withoutIds(descriptor);
  return isAnonymous(semantic) ? descriptor : semantic;
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
 * action, tier by tier, against the same node map (and again per settling
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
 * Relocates one descriptor against the nodes of a fresh observation
 * (`matchingIds`), exactly-one-or-diverge. Ambiguity diverges immediately:
 * two candidates sharing the matched identity cannot be told apart by
 * waiting, and acting on either would be a guess.
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
  // A lone match is the node for a descriptor recorded alone. One recorded
  // among twins has only its count and place: one survivor where the
  // recording counted two is as likely the other twin as the right one, and
  // among label twins it is whichever one still reads as recorded, which
  // after the step acted on the recorded one is exactly the wrong one.
  if (matches.length === 1 && (position === undefined || position.of === 1)) return { kind: 'found', id: matches[0]! };
  const positioned = position !== undefined && position.of === matches.length ? matches[position.index] : undefined;
  return positioned === undefined
    ? { kind: 'failed', failure: 'target-ambiguous', candidates: matches }
    : { kind: 'found', id: positioned };
}

/**
 * The ids a descriptor matches in a fresh observation, in document order:
 * the first tier that matches anything decides.
 *
 * 1. With a recorded test id: every node of that kind with that id. One is
 *    the control; several are twins the recorded position tells apart; none
 *    means the id churned, and the tiers below take over.
 * 2. With a recorded element id (a document platform's authored `id`): the
 *    same, one rung weaker because an id is not written for tests.
 * 3. The nodes whose labels equal the recording's exactly.
 * 4. The nodes whose labels share the recording's shape (`labelShape`), so a
 *    control whose label counts or times something is found once the count
 *    moved.
 *
 * A recorded position holds on every rung: a rung that finds another number
 * of controls than were counted is looking at a different set.
 *
 * Empty when nothing matches. The recorder uses the same projection to
 * notice, before it writes a target, that the description alone would not
 * tell the target from its twins.
 */
function matchingIds(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, SemanticNode>,
  options: DescriptorMatchOptions,
): readonly string[] {
  if (!isRelocatableDescriptor(descriptor)) return [];
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
  const twins = descriptor.position?.of;
  // The first rung that matched anything, kept for when no rung finds the
  // recorded number of twins: its matches are the candidates a caller with a
  // recorded point may still tell apart.
  let first: readonly string[] | undefined;
  for (const tier of matchingTiers(descriptor)) {
    const matched = keyed.filter((candidate) => tier(candidate.descriptor));
    if (matched.length === 0) continue;
    const ids = matched.map((candidate) => candidate.id);
    // A position was counted among the controls the first matching rung found
    // when it was recorded. A rung that finds another number of them now is
    // looking at a different set, where the recorded index would name an
    // unrelated control, so the rungs below get their turn.
    if (twins !== undefined && twins > 1 && matched.length !== twins) {
      first ??= ids;
      continue;
    }
    return ids;
  }
  return first ?? [];
}

/** One tier of the ladder: whether a candidate's projection matches the recording at that tier. */
type MatchTier = (candidate: TraceTargetDescriptor) => boolean;

function matchingTiers(descriptor: TraceTargetDescriptor): readonly MatchTier[] {
  if (isAnonymous(descriptor)) return [(candidate) => fieldsIdentical(descriptor, candidate, ALL_IDENTITY_FIELDS)];
  const semantic = withoutIds(descriptor);
  const labels: readonly LabelField[] = semantic.name === undefined ? ['name', 'text'] : ['name'];
  return [
    ...ID_FIELDS.filter((id) => descriptor[id] !== undefined).map(
      (id) => (candidate: TraceTargetDescriptor) => fieldsEqual(descriptor, candidate, [id, ...SEMANTIC_ID_FIELDS]),
    ),
    ...(isAnonymous(semantic)
      ? []
      : [
          (candidate: TraceTargetDescriptor) => fieldsEqual(semantic, candidate, [...SEMANTIC_ID_FIELDS, ...labels]),
          (candidate: TraceTargetDescriptor) =>
            fieldsEqual(semantic, candidate, SEMANTIC_ID_FIELDS) && sameLabels(semantic, candidate, labels, 'counts'),
        ]),
  ];
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
