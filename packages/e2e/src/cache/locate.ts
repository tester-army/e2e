/**
 * The cache's locator: how a recorded descriptor is found on a fresh
 * observation. One mechanism serves every lookup the cache makes: a replayed
 * action re-aims at its target (`relocateWithFallbacks`), a live step re-finds
 * a node it saw a moment ago (`relocateExact`), a replay checks that the
 * recorded end state is on screen (`locatePresent`, used by `anchors.ts`), and
 * a recording notes where a target sits among its twins (`describePosition`).
 *
 * A lookup splits what the recording says into identity, which node it is,
 * and content, what that node must read or be. Candidates are the projected
 * nodes in the recorded container that carry the content; the identity then
 * walks a ladder: the exact match first, then fallbacks that each keep the
 * most stable evidence the recording has left, the test id before the
 * accessible name. Content is never loosened. Two kinds of evidence that
 * point at different nodes, or a name match outside the nodes still carrying
 * the recorded test id, hand off. `README.md` beside this file has the whole
 * design.
 *
 * Candidates are compared through the same `describeTarget` projection the
 * recorder used, so redaction, whitespace collapsing, and bounding cannot
 * make a node unequal to its own recording.
 */

import type { RedactedNode } from '../agent/observation.ts';
import { containerKey, describeTarget, parentsOf } from '../agent/actions.ts';
import { collapseText } from '../internal/text.ts';
import { bound, MAX_TRACE_DESCRIPTOR_CHARS, TRACE_ANCHOR_STATES, type TraceAnchorState, type TracePosition, type TraceTargetDescriptor } from './trace.ts';

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

/**
 * Which fallback rung re-found a recorded target when the exact match found
 * nothing (`relocateWithFallbacks`): `test-id`, its test id while its label,
 * text, or role changed; `accessible`, its role and accessible name while
 * its test id, placeholder, or text changed; `role-family`, its accessible
 * name on a control of the same kind under another role (a link that became
 * a button).
 */
export type RelocationFallback = 'test-id' | 'accessible' | 'role-family';

export type RelocationResult =
  | {
      readonly kind: 'found';
      readonly id: string;
      /** Set when only a fallback rung found the node: the recording drifted from the app. */
      readonly fallback?: RelocationFallback;
    }
  | { readonly kind: 'failed'; readonly failure: 'target-not-found' }
  /** Several nodes share the matched identity; a caller with other evidence (a recorded point) may still tell them apart. */
  | {
      readonly kind: 'failed';
      readonly failure: 'target-ambiguous';
      readonly candidates: readonly string[];
      /**
       * Set when the candidates are not look-alikes but the picks of two
       * kinds of evidence that disagree (a test id on one control, the
       * recorded name on another). Nothing recorded tells them apart, a point
       * included, though a screen still settling may.
       */
      readonly conflict?: true;
    };

export type DescriptorField = keyof TraceTargetDescriptor;

/** One node of an observation as every lookup compares it, computed once per observation. */
export interface ProjectedNode {
  readonly id: string;
  /** The node as the recorder describes a target (`describeTarget`). */
  readonly descriptor: TraceTargetDescriptor;
  /** Its input value, collapsed and bounded; undefined for none and for a secure field, which is never observed. */
  readonly value: string | undefined;
  /** The states that are on, in `TRACE_ANCHOR_STATES` order. */
  readonly states: readonly TraceAnchorState[];
  readonly leaf: boolean;
}

/** A node a lookup may pick: its id and the descriptor it is compared by. */
interface Candidate {
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
  if (!isAnonymous(descriptor)) return true;
  const { position } = descriptor;
  return descriptor.role !== undefined && position !== undefined && (position.of === 1 || descriptor.within !== undefined);
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
function fieldsEqual(
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
 * Node projections per observation. A replay relocates every recorded
 * action, in several tiers, against the same node map (and again per
 * settling retry), and checks every anchor against it once per poll, while
 * the projection of a node is a pure function of the node: it is computed
 * once per observation and shared by every lookup into it.
 */
const projections = new WeakMap<ReadonlyMap<string, RedactedNode>, readonly ProjectedNode[]>();

/** Projects every node of an observation the way the recorder described its targets, in document order. */
export function projectNodes(nodes: ReadonlyMap<string, RedactedNode>): readonly ProjectedNode[] {
  const cached = projections.get(nodes);
  if (cached !== undefined) return cached;
  const projected: ProjectedNode[] = [];
  for (const [id, node] of nodes) {
    const descriptor = describeTarget(node);
    if (descriptor === undefined) continue;
    const value = node.value === undefined || node.states?.secure === true ? '' : collapseText(node.value);
    projected.push({
      id,
      descriptor,
      value: value === '' ? undefined : bound(value, MAX_TRACE_DESCRIPTOR_CHARS),
      states: TRACE_ANCHOR_STATES.filter((state) => node.states?.[state] === true),
      leaf: node.children === undefined || node.children.length === 0,
    });
  }
  projections.set(nodes, projected);
  return projected;
}

/** One key for a set of states, the same for a recorded list and a projected one. */
export function statesKey(states: readonly TraceAnchorState[] | undefined): string {
  return states === undefined ? '' : states.join(',');
}

/**
 * What a lookup returns when its identity matched: `target` asks for one
 * node, alone or at its recorded place among the same count of twins
 * (`pick`), since an action on a guess acts on the wrong control; `present`
 * takes every match, since an end state shown twice is still shown.
 */
type LocateMode = 'target' | 'present';

/**
 * Relocates one descriptor against the nodes of a fresh observation, tier by
 * tier (`descriptorTiers`), each exactly-one-or-diverge. Ambiguity at any
 * tier diverges immediately: two candidates sharing the matched identity
 * cannot be told apart by waiting, and acting on either would be a guess.
 * The one exception is a recorded `position`: the recording itself found the
 * same twins and noted which one it acted on, so the same count of twins
 * resolves to the same one; any other count diverges as before.
 *
 * This is the exact match, what a live step uses to re-find a node it saw a
 * moment ago. A replay of a recording made on another day walks the
 * fallbacks too (`relocateWithFallbacks`).
 */
export function relocateExact(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, RedactedNode>,
): RelocationResult {
  return locate(descriptor, targetPool(descriptor, nodes), 'target', false);
}

/**
 * Relocates a recorded target, falling back rung by rung when the exact
 * match (`relocateExact`) finds nothing. Each rung keeps less of the
 * recording, most stable evidence first: the test id with the role, the test
 * id alone, the role and accessible name, then the name on a control of the
 * same kind (`fallbackRungs`). The first rung that settles on one node, or
 * on the recorded place among the same count of twins, wins.
 *
 * What never loosens: a recorded container (`within`) and a tapped toggle's
 * state must hold on every rung, an exact match that is ambiguous diverges
 * rather than falling back, since every rung only widens it, and an
 * anonymous control has no fallback. When the test id names one node and
 * the accessible name another, the recording is evidence for both and the
 * replay hands off.
 */
export function relocateWithFallbacks(
  descriptor: TraceTargetDescriptor,
  nodes: ReadonlyMap<string, RedactedNode>,
): RelocationResult {
  return locate(descriptor, targetPool(descriptor, nodes), 'target', true);
}

/**
 * Whether a recorded identity is on screen carrying its content: some node
 * in `pool` that `carries` the recorded content matches `identity` on the
 * exact tiers or, with `fallbacks`, on the first fallback rung that matches
 * any. `conflict` when the only match lies outside the nodes still carrying
 * the recorded test id: the evidence disagrees, so the end state is neither
 * shown nor gone. The caller compares shapes (`anchors.ts`): `pool` and
 * `identity` are in the form it compares, and `carries` checks the content
 * the identity leaves out.
 */
export function locatePresent(
  identity: TraceTargetDescriptor,
  pool: readonly ContentCandidate[],
  fallbacks: boolean,
): 'present' | 'absent' | 'conflict' {
  const result = locate(identity, pool, 'present', fallbacks);
  return result.kind === 'found' ? 'present' : result.failure === 'target-ambiguous' ? 'conflict' : 'absent';
}

/** A candidate with whether it carries the content the lookup asks for. */
export interface ContentCandidate extends Candidate {
  readonly carries: boolean;
}

/**
 * The one lookup every caller shares. `pool` is the nodes the descriptor may
 * be found among, each marked with whether it carries the recorded content;
 * only those that do are matched, while the test id holders that veto a
 * name-based pick are counted over the whole pool, so a control still
 * carrying the recorded test id in another state or reading is evidence
 * against picking another one.
 */
function locate(
  descriptor: TraceTargetDescriptor,
  pool: readonly ContentCandidate[],
  mode: LocateMode,
  fallbacks: boolean,
): RelocationResult {
  const candidates = pool.filter((candidate) => candidate.carries);
  const holders = descriptor.testId === undefined ? [] : pool.filter((candidate) => candidate.descriptor.testId === descriptor.testId);
  const choose = (ids: readonly string[]): RelocationResult => {
    if (mode === 'target') return pick(descriptor, ids);
    if (ids.length === 0) return NOT_FOUND;
    return { kind: 'found', id: ids.find((id) => holders.some((holder) => holder.id === id)) ?? ids[0]! };
  };
  // A pick made without the test id must be one of the nodes still carrying
  // it when there are any: the semantic tier and the name rungs forgive a
  // test id the app re-minted, not one that moved.
  const settle = (found: Extract<RelocationResult, { kind: 'found' }>, others: Iterable<string>): RelocationResult => {
    const disagreeing = new Set([found.id, ...others]);
    if (holders.length > 0 && !holders.some((holder) => holder.id === found.id)) for (const holder of holders) disagreeing.add(holder.id);
    if (disagreeing.size === 1) return found;
    const inOrder = pool.filter((candidate) => disagreeing.has(candidate.id)).map((candidate) => candidate.id);
    return { kind: 'failed', failure: 'target-ambiguous', candidates: inOrder, conflict: true };
  };
  const exact = choose(matchingIds(descriptor, candidates));
  if (exact.kind === 'found') return settle(exact, []);
  if (!fallbacks || exact.failure === 'target-ambiguous') return exact;
  const picks = new Map<RungEvidence, string>();
  let winner: { readonly kind: 'found'; readonly id: string; readonly fallback: RelocationFallback } | undefined;
  for (const rung of fallbackRungs(descriptor)) {
    if (picks.has(rung.evidence)) continue;
    const result = choose(candidates.filter((candidate) => rung.matches(candidate.descriptor)).map((candidate) => candidate.id));
    if (result.kind !== 'found') continue;
    picks.set(rung.evidence, result.id);
    winner ??= { kind: 'found', id: result.id, fallback: rung.fallback };
  }
  if (winner === undefined) return NOT_FOUND;
  // An action needs every kind of evidence to agree. An end state shown on
  // the node the first rung names is shown, wherever else its name reads.
  return settle(winner, mode === 'target' ? picks.values() : []);
}

const NOT_FOUND: RelocationResult = { kind: 'failed', failure: 'target-not-found' };

/**
 * The pool a recorded target is found among: the projected nodes in its
 * recorded container (`within`), each carrying the content when it is in the
 * state a tapped toggle was recorded in. A recorded container key must hold:
 * the same "Delete" in another row is a different control. Checked against
 * the tree the candidates came from, never guessed. A toggle in the other
 * state is not the control the recording tapped, since the tap would flip it
 * the other way.
 */
function targetPool(descriptor: TraceTargetDescriptor, nodes: ReadonlyMap<string, RedactedNode>): readonly ContentCandidate[] {
  const recorded = descriptor.states === undefined ? undefined : statesKey(descriptor.states);
  const parents = descriptor.within === undefined ? undefined : parentsOf(nodes);
  return projectNodes(nodes)
    .filter((node) => parents === undefined || containerKey(node.id, nodes, parents) === descriptor.within)
    .map((node) => ({ id: node.id, descriptor: node.descriptor, carries: recorded === undefined || statesKey(node.states) === recorded }));
}

/**
 * The one node among `matches` a descriptor names: a lone match for a
 * descriptor recorded alone, else the recorded place among the same count of
 * twins. One recorded among twins has only its count and place: one survivor
 * where the recording counted two is as likely the other twin as the right
 * one, and among label twins it is whichever one still reads as recorded,
 * which after the step acted on the recorded one is exactly the wrong one.
 */
function pick(descriptor: TraceTargetDescriptor, matches: readonly string[]): RelocationResult {
  if (matches.length === 0) return { kind: 'failed', failure: 'target-not-found' };
  const { position } = descriptor;
  if (matches.length === 1 && (position === undefined || position.of === 1)) return { kind: 'found', id: matches[0]! };
  const positioned = position !== undefined && position.of === matches.length ? matches[position.index] : undefined;
  return positioned === undefined
    ? { kind: 'failed', failure: 'target-ambiguous', candidates: matches }
    : { kind: 'found', id: positioned };
}

/** The independent kinds of evidence a fallback rests on; two that settle on different nodes disagree. */
type RungEvidence = 'test-id' | 'name';

/** One fallback rung: what it keeps of the recording, and the report label of a match on it. */
interface FallbackRung {
  readonly fallback: RelocationFallback;
  readonly evidence: RungEvidence;
  readonly matches: (candidate: TraceTargetDescriptor) => boolean;
}

/**
 * Roles that are one kind of control to a user, so a role change inside a
 * family is a refactor rather than another control: a link restyled as a
 * button, a checkbox redrawn as a switch, a text field given suggestions.
 * A role in no family never falls back across roles.
 */
const ROLE_FAMILIES: readonly ReadonlySet<string>[] = [
  new Set(['button', 'link', 'menuitem', 'tab']),
  new Set(['checkbox', 'switch', 'menuitemcheckbox']),
  new Set(['radio', 'menuitemradio']),
  new Set(['textbox', 'searchbox', 'combobox']),
];

/**
 * The fallback rungs for one recorded descriptor, most stable first. A test
 * id is the app's own name for a control and outlives copy changes, so it
 * leads: with the role, then alone. The accessible name follows: the role
 * and name alone (a test id, placeholder, or text that changed), then the
 * name across a role family. Each rung is evidence of one kind; the first match of each kind is compared with the
 * other's (`relocateWithFallbacks`). None for an anonymous descriptor, whose
 * place among its twins is all it has.
 */
function fallbackRungs(descriptor: TraceTargetDescriptor): readonly FallbackRung[] {
  if (!isRelocatableDescriptor(descriptor) || isAnonymous(descriptor)) return [];
  const rungs: FallbackRung[] = [];
  const { testId, role, name } = descriptor;
  if (testId !== undefined) {
    if (role !== undefined) {
      rungs.push({ fallback: 'test-id', evidence: 'test-id', matches: (candidate) => candidate.testId === testId && candidate.role === role });
    }
    rungs.push({ fallback: 'test-id', evidence: 'test-id', matches: (candidate) => candidate.testId === testId });
  }
  if (name !== undefined && role !== undefined) {
    rungs.push({ fallback: 'accessible', evidence: 'name', matches: (candidate) => candidate.name === name && candidate.role === role });
    const family = ROLE_FAMILIES.find((roles) => roles.has(role));
    if (family !== undefined) {
      rungs.push({
        fallback: 'role-family',
        evidence: 'name',
        matches: (candidate) => candidate.name === name && candidate.role !== undefined && family.has(candidate.role),
      });
    }
  }
  return rungs;
}

/**
 * The ids a descriptor matches in a fresh observation, in document order: the
 * strictest tier (`descriptorTiers`) that matches anything decides, so a
 * churned test id still falls back to the semantic fields. Empty when nothing
 * matches. The recorder uses the same projection to notice, before it writes a
 * target, that the description alone would not tell the target from its twins.
 */
function matchingIds(descriptor: TraceTargetDescriptor, keyed: readonly Candidate[]): readonly string[] {
  for (const tier of descriptorTiers(descriptor)) {
    const matches = tierMatches(tier, keyed);
    if (matches.length > 0) return matches;
  }
  return [];
}

function tierMatches(tier: TraceTargetDescriptor, candidates: readonly Candidate[]): string[] {
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
  node: RedactedNode,
  within: string | undefined,
  nodes: ReadonlyMap<string, RedactedNode>,
): TracePosition | undefined {
  const described = describeTarget(node);
  if (described === undefined || (described.role === undefined && isAnonymous(described))) return undefined;
  // An anonymous target has no identity to match alone; its position is what
  // makes it relocatable, so it is counted among its unnamed twins even when
  // it is the only one, and described with a placeholder position to do so.
  const anonymous = isAnonymous(described);
  const probe = { ...described, ...(within === undefined ? {} : { within }), ...(anonymous ? { position: { index: 0, of: 1 } } : {}) };
  const ids = matchingIds(probe, targetPool(probe, nodes));
  if (ids.length < (anonymous ? 1 : 2) || ids.length > MAX_POSITIONED_TWINS) return undefined;
  const index = ids.indexOf(node.ref.id);
  return index === -1 ? undefined : { index, of: ids.length };
}
