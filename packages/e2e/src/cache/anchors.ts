/**
 * End anchors.
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
  AGE,
  describeNodes,
  fieldsEqual,
  identifyingProjection,
  isAnonymous,
  isRelocatableDescriptor,
  RELATIVE_TIME,
  sameLabels,
  SEMANTIC_ID_FIELDS,
  withoutIds,
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
const ANCHOR_FIELDS: readonly DescriptorField[] = ['role', 'name', 'text', 'testId', 'elementId', 'placeholder', 'inputPurpose'];

/**
 * Derives the end anchors of one step: relocatable descriptors present in the
 * passing observation and absent from the starting one, deduplicated, capped.
 * Stable leaves are the anchors; stable containers stand in when every leaf
 * that appeared is volatile, and only with nothing stable at all do the
 * volatile leaves, then containers, stay. A container's accessible name is usually the concatenation of its children's,
 * so it repeats what the leaves already say, and whether a screen's shell
 * groups (a tab bar, a scroll view named after its first tab) are listed at
 * all differs from one capture to the next on a device, so a replay whose
 * effect is plainly on screen would still hand off over them.
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
  const stable = (anchors: TraceTargetDescriptor[]): TraceTargetDescriptor[] => anchors.filter((anchor) => !isVolatileAnchor(anchor));
  // Stable leaves, else stable containers, else whatever appeared: a volatile
  // leaf beside a steady group must not push the group out.
  const chosen = [stable(leaves), stable(containers), leaves, containers].find((group) => group.length > 0) ?? [];
  return chosen.toSorted((a, b) => durability(a) - durability(b)).slice(0, MAX_TRACE_ANCHORS);
}

/**
 * How well an anchor survives a re-render, best first, so the cap drops the
 * fragile ones: a labelled node with a test id, then a node only a test id
 * names, then a node its text names, then one its accessible name names,
 * which on a device is often a concatenation. `toSorted` is stable, so
 * ties keep document order.
 */
function durability(anchor: TraceTargetDescriptor): number {
  if (anchor.testId !== undefined || anchor.elementId !== undefined) return anchor.name !== undefined || anchor.text !== undefined ? 0 : 1;
  if (anchor.text !== undefined) return 2;
  return 3;
}

/**
 * Text that cannot read the same on the next run: a minted key prefix or id,
 * a countdown or age, a relative time (`now`, `yesterday`), a date, a clock
 * time, a timing in milliseconds, a pagination range or record count that
 * grows with the data every run leaves behind, or a social tally (`1 like`,
 * `Reply (2 replies)`) that moves with every step before it. An anchor made
 * of it hands every replay off, so it is skipped while some stable anchor
 * exists; with nothing else, the volatile ones stay, because a replay that
 * always hands off is still safer than one that passes on mechanics alone.
 */
const VOLATILE_TEXT: readonly RegExp[] = [
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b/,
  AGE,
  RELATIVE_TIME,
  /\b\d+\s+(?:likes?|reposts?|quotes?|repl(?:y|ies)|followers?|following|comments?|views?|posts?|members?|notifications?|mentions?|unread|new)\b/i,
  /\(\s*\d+\s+[a-z]+\s*\)/i,
  /\b\d+\s*(?:to|-|\u2013)\s*\d+\s+of\s+\d+\b/i,
  /\b\d+\s+(?:results?|items?|rows?|entries|records?|matches|total)\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?\b/i,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/,
];

/**
 * A bare number is a badge or a tally, `11` unread, and reads differently
 * once the data changes; it is volatile when it is all the anchor has to say.
 * The same digit inside a named control, a status labelled "Counter" that
 * reads `1` after one increment, is the step's effect and stays.
 */
function isBareNumber(anchor: TraceTargetDescriptor): boolean {
  const label = anchor.name ?? anchor.text;
  return label !== undefined && /^\d+$/.test(label) && anchor.testId === undefined && (anchor.name === undefined || anchor.text === undefined || anchor.name === anchor.text);
}

function isVolatileAnchor(anchor: TraceTargetDescriptor): boolean {
  return (
    isBareNumber(anchor) ||
    [anchor.text, anchor.name].some((value) => value !== undefined && VOLATILE_TEXT.some((pattern) => pattern.test(value)))
  );
}

/**
 * Whether every anchor is present in a fresh observation: some candidate
 * matches every anchor (`anchorMatches`). Two matching nodes are the effect
 * twice over, not an ambiguity.
 */
export function anchorsPresent(
  anchors: readonly TraceTargetDescriptor[],
  nodes: ReadonlyMap<string, SemanticNode>,
  options: AnchorOptions,
): boolean {
  return missingAnchors(anchors, nodes, options).length === 0;
}

/**
 * The anchors a fresh observation does not show, in recorded order: the
 * effect a hand-off is missing, named so the report and the agent can say
 * which one rather than only that the end state differed.
 */
export function missingAnchors(
  anchors: readonly TraceTargetDescriptor[],
  nodes: ReadonlyMap<string, SemanticNode>,
  options: AnchorOptions,
): TraceTargetDescriptor[] {
  const candidates = describeNodes(nodes, options).map((node) => node.descriptor);
  return anchors.filter((anchor) => !candidates.some((candidate) => anchorMatches(anchor, candidate)));
}

/**
 * Whether a candidate is the anchor: the same kind of node, with both labels
 * reading as recorded once relative times are folded (`Bob · now` is still
 * the post at `Bob · 5m`). Counts are not folded: an anchor that says
 * `Count: 1` or `Cart (2 items)` is usually the very effect the step had, and
 * a screen left at `Count: 0` must not pass as it. A recorded test id
 * identifies the node when the candidate carries it; otherwise, or when the
 * id churned, the remaining fields must identify it on their own, as
 * `identifyingProjection` keys it.
 */
function anchorMatches(anchor: TraceTargetDescriptor, candidate: TraceTargetDescriptor): boolean {
  const semantic = withoutIds(anchor);
  const sameId = (anchor.testId !== undefined && candidate.testId === anchor.testId) || (anchor.elementId !== undefined && candidate.elementId === anchor.elementId);
  const identified = sameId || !isAnonymous(semantic);
  return identified && fieldsEqual(semantic, candidate, SEMANTIC_ID_FIELDS) && sameLabels(anchor, candidate, ['name', 'text'], 'times');
}

/** One anchor as prose, the way an action summary names its target: `text "Saved"`, `button "Publish" (testid postBtn)`. */
export function describeAnchor(anchor: TraceTargetDescriptor): string {
  const label = anchor.name ?? anchor.text ?? anchor.placeholder;
  const role = anchor.role ?? 'node';
  const named = label === undefined ? role : `${role} ${JSON.stringify(label)}`;
  return anchor.testId === undefined ? named : `${named} (testid ${anchor.testId})`;
}

/** One node's anchor projection, or undefined when it could identify nothing. */
function anchorDescriptor(node: SemanticNode, options: AnchorOptions): TraceTargetDescriptor | undefined {
  const described = describeTarget(node, options.redact);
  if (described === undefined || !isRelocatableDescriptor(described)) return undefined;
  const { selector: _selector, ...anchor } = described;
  return anchor;
}

/** Set key for one descriptor: its identifying projection over the anchor fields, in fixed order. */
function anchorKey(descriptor: TraceTargetDescriptor): string {
  const projection = identifyingProjection(descriptor);
  return JSON.stringify(ANCHOR_FIELDS.map((field) => projection[field]));
}
