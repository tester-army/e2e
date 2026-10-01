/**
 * Anchors: the step's recorded delta.
 *
 * A recording run does not end when its last action commits; it ends when the
 * executor looks at the screen and judges the step done. The trace used to
 * keep only the actions and drop that look, so a replay could run every
 * recorded action mechanically — a fill that never committed, a save that
 * produced an unnamed record — and self-finalize with nothing checking the
 * effect. Anchors restore the check as data: the descriptors of nodes the
 * step made appear (`endAnchors`) and of nodes it made vanish
 * (`goneAnchors`), each with the states a step sets on a control it leaves
 * on screen (a switch turned on, a field typed into). They are checked by
 * the relocation vocabulary (`relocate.ts`) with two deliberate differences:
 * every recorded field must be equal, text, value, and states included, and
 * presence is enough, uniqueness is not asked.
 *
 * A replay passes on its own only when the delta happened again: everything
 * that appeared is there, everything that vanished is gone, and at least one
 * of those changes, or the route, actually moved during the replay
 * (`deltaEvidenced`), so a status that already read "Submitted" before a
 * submit that did nothing is no proof. An alert the replay raised that the
 * recording never saw is an outcome the recording did not have, whatever
 * else matched (`deltaHolds`).
 */

import type { RedactedNode } from '../agent/observation.ts';
import { describeTarget } from '../agent/actions.ts';
import { collapseText } from '../internal/text.ts';
import { descriptorTiers, fieldsEqual, type DescriptorField } from './relocate.ts';
import {
  bound,
  MAX_TRACE_ANCHORS,
  MAX_TRACE_DESCRIPTOR_CHARS,
  TRACE_ANCHOR_STATES,
  type TraceAnchorState,
  type TraceTargetDescriptor,
} from './trace.ts';

/** The two sides of one step's delta, each projected, deduplicated, ordered, and capped. */
export interface StepDelta {
  /** On screen when the step passed, not when it began. */
  readonly appeared: TraceTargetDescriptor[];
  /** On screen when the step began, not when it passed. */
  readonly gone: TraceTargetDescriptor[];
}

/** The recorded delta a replay checks, as a trace carries it. */
export interface RecordedDelta {
  readonly endAnchors?: readonly TraceTargetDescriptor[];
  readonly goneAnchors?: readonly TraceTargetDescriptor[];
}

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
 * Roles an app announces an outcome in: the ARIA live regions a screen
 * reader reads out on change, and the alert dialog. The app itself says
 * this text reports what just happened, so these are recorded before any
 * other anchor and the cap never crowds them out.
 */
const ANNOUNCEMENT_ROLES: ReadonlySet<string> = new Set(['alert', 'alertdialog', 'status']);

/**
 * The announcements that interrupt: an error, a warning, a confirmation the
 * user must answer. A replay that raises one the recording never saw has
 * another outcome than the recording, so every one that appears is recorded
 * whatever its text, and checked both ways.
 */
const ALERT_ROLES: ReadonlySet<string> = new Set(['alert', 'alertdialog']);

/**
 * Derives one step's delta between its starting observation and its passing
 * one. Each side is ordered announcements first, then leaves, then
 * containers, each in document order: a container's accessible name is
 * usually the concatenation of its children's, so it repeats what the
 * leaves already say, and on a list-heavy screen those repeats would crowd
 * the one status line that names the effect out of the cap. `routeMoved`
 * says the step ended on another route than it began on, whose counts are
 * that screen's data rather than the step's result (`COUNT_TEXT`).
 */
export function describeDelta(
  startNodes: ReadonlyMap<string, RedactedNode>,
  endNodes: ReadonlyMap<string, RedactedNode>,
  routeMoved: boolean,
): StepDelta {
  const start = projectAnchors(startNodes);
  const end = projectAnchors(endNodes);
  return { appeared: deltaSide(end, start, routeMoved), gone: deltaSide(start, end, routeMoved) };
}

/** One projected anchor with the node it came from. */
interface AnchorNode {
  readonly descriptor: TraceTargetDescriptor;
  readonly key: string;
  readonly leaf: boolean;
}

/** The side of the delta `nodes` holds and `other` does not, ordered and capped. */
function deltaSide(nodes: readonly AnchorNode[], other: readonly AnchorNode[], routeMoved: boolean): TraceTargetDescriptor[] {
  const otherKeys = new Set(other.map((anchor) => anchor.key));
  const otherShapes = new Set(other.map((anchor) => countShape(anchor.descriptor)));
  const volatile = (anchor: TraceTargetDescriptor) => isVolatileAnchor(anchor, (count) => routeMoved || otherShapes.has(countShape(count)));
  const seen = new Set<string>();
  const announcements: AnchorNode[] = [];
  const leaves: AnchorNode[] = [];
  const containers: AnchorNode[] = [];
  for (const anchor of nodes) {
    if (otherKeys.has(anchor.key) || seen.has(anchor.key)) continue;
    seen.add(anchor.key);
    const role = anchor.descriptor.role ?? '';
    (ANNOUNCEMENT_ROLES.has(role) ? announcements : anchor.leaf ? leaves : containers).push(anchor);
  }
  const all = [...announcements, ...leaves, ...containers];
  const stable = all.filter((anchor) => isAlert(anchor.descriptor) || !volatile(anchor.descriptor));
  return (stable.length > 0 ? stable : all).slice(0, MAX_TRACE_ANCHORS).map((anchor) => anchor.descriptor);
}

/**
 * Text that cannot read the same on the next run: a minted key prefix or id,
 * a countdown or age, a date, a clock time, a timing in milliseconds. An
 * anchor made of it hands every replay off, so it is skipped while some
 * stable anchor exists; with nothing else, the volatile ones stay, because a
 * replay that always hands off is still safer than one that passes on
 * mechanics alone. An alert keeps it, and is compared with these parts read
 * as placeholders (`alertShape`).
 */
const VOLATILE_TEXT: readonly RegExp[] = [
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b/,
  /\b\d+\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|weeks?|months?|years?)\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?\b/i,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/,
];

/**
 * A count that names what it counts: a pagination range, `12 items`, `3
 * records imported`. Such a count is the step's own result when the step
 * made it appear on the screen it acted on, and must read the same again:
 * `0 records imported` is not the import the recording saw. It is the data
 * instead, which the next run, with what an earlier run left behind, reads
 * differently, when the other side of the delta already showed the same
 * text with other numbers (`41 items` became `42 items`), or when the step
 * moved to another route and the count is part of the screen it opened.
 */
const COUNT_TEXT: readonly RegExp[] = [
  /\b\d+\s*(?:to|-|\u2013)\s*\d+\s+of\s+\d+\b/i,
  /\b\d+\s+(?:results?|items?|rows?|entries|records?|matches|total)\b/i,
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

/** Whether an anchor's text cannot read the same on the next run; `countIsData` decides an anchor holding a count. */
function isVolatileAnchor(anchor: TraceTargetDescriptor, countIsData: (anchor: TraceTargetDescriptor) => boolean): boolean {
  const texts = [anchor.text, anchor.name, anchor.value].filter((value): value is string => value !== undefined);
  if (isBareNumber(anchor) || texts.some((value) => VOLATILE_TEXT.some((pattern) => pattern.test(value)))) return true;
  return texts.some((value) => COUNT_TEXT.some((pattern) => pattern.test(value))) && countIsData(anchor);
}

/** An anchor with every digit run read as one placeholder: the text a running count keeps while its numbers move. */
function countShape(anchor: TraceTargetDescriptor): string {
  return anchorKey({ ...anchor, ...digitless('name', anchor.name), ...digitless('text', anchor.text), ...digitless('value', anchor.value) });
}

function digitless(field: 'name' | 'text' | 'value', value: string | undefined): Partial<TraceTargetDescriptor> {
  return value === undefined ? {} : { [field]: value.replace(/\d+/g, '#') };
}

function isAlert(anchor: TraceTargetDescriptor): boolean {
  return anchor.role !== undefined && ALERT_ROLES.has(anchor.role);
}

const VOLATILE_SPANS: readonly RegExp[] = VOLATILE_TEXT.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));

/**
 * An alert with its volatile parts read as one placeholder each: `Session
 * expires at 17:42` and `Session expires at 17:45` are the same alert, which
 * a replay must neither miss nor mistake for one the recording never saw.
 */
function alertShape(anchor: TraceTargetDescriptor): TraceTargetDescriptor {
  const mask = (text: string) => VOLATILE_SPANS.reduce((masked, span) => masked.replace(span, '#'), text);
  return {
    ...anchor,
    ...(anchor.name === undefined ? {} : { name: mask(anchor.name) }),
    ...(anchor.text === undefined ? {} : { text: mask(anchor.text) }),
  };
}

/**
 * Whether the recorded end state holds on a fresh observation: every
 * appeared anchor present (some tier of it, `descriptorTiers`, so a test id
 * that churned per render is forgiven when the remaining fields still
 * identify the node, equal on every anchor field and state), no gone anchor
 * present, and no alert on screen that was not on `beforeNodes` and is not
 * one the recording saw appear. Two nodes matching one anchor are the effect
 * twice over, not an ambiguity.
 */
export function deltaHolds(
  delta: RecordedDelta,
  nodes: ReadonlyMap<string, RedactedNode>,
  beforeNodes: ReadonlyMap<string, RedactedNode>,
): boolean {
  const live = projectAnchors(nodes);
  const appeared = delta.endAnchors ?? [];
  if (!appeared.every((anchor) => anchorIn(anchor, live))) return false;
  if ((delta.goneAnchors ?? []).some((anchor) => anchorIn(anchor, live))) return false;
  const before = projectAnchors(beforeNodes).filter((anchor) => isAlert(anchor.descriptor));
  return live.every(
    (anchor) =>
      !isAlert(anchor.descriptor) ||
      before.some((earlier) => anchorIn(anchor.descriptor, [earlier])) ||
      appeared.some((recorded) => anchorIn(recorded, [anchor])),
  );
}

/**
 * Whether the replay itself produced some of the recorded delta, measured
 * from `baselineNodes`, the first screen the replay saw on the route it
 * ended on: an anchor that appeared was absent there, or a gone one was
 * there. Without that, every check `deltaHolds` makes could have held before
 * the actions that should have produced it: the screen already read the
 * outcome, and nothing the replay did is proven to have done anything. A
 * recording with no delta at all is never evidence. Undefined `baselineNodes`
 * means the replay saw no screen on that route before its last action, so
 * that action moved the route, which is the evidence.
 *
 * A control one of the trace's own actions targeted (`inputTargets`) that
 * shows on both sides of the delta, a field typed into or a switch flipped,
 * echoes the input: the replay typed, so the value is there, whatever the
 * step was for. Such echoes are evidence only when the delta holds nothing
 * else; otherwise the rest of the delta must have moved, so a subscribe
 * form typed into on a page that already read "You're subscribed" proves
 * nothing.
 */
export function deltaEvidenced(
  delta: RecordedDelta,
  baselineNodes: ReadonlyMap<string, RedactedNode> | undefined,
  inputTargets: readonly TraceTargetDescriptor[],
): boolean {
  if (baselineNodes === undefined) return true;
  const appeared = delta.endAnchors ?? [];
  const gone = delta.goneAnchors ?? [];
  const targets = new Set(inputTargets.map(identityKey));
  const changed = new Set(appeared.map(identityKey).filter((key) => gone.some((anchor) => identityKey(anchor) === key)));
  const echoes = (anchor: TraceTargetDescriptor) => changed.has(identityKey(anchor)) && targets.has(identityKey(anchor));
  const outcome = [...appeared, ...gone].some((anchor) => !echoes(anchor));
  const counted = (anchor: TraceTargetDescriptor) => !outcome || !echoes(anchor);
  const baseline = projectAnchors(baselineNodes);
  return (
    appeared.some((anchor) => counted(anchor) && !anchorIn(anchor, baseline)) ||
    gone.some((anchor) => counted(anchor) && anchorIn(anchor, baseline))
  );
}

/** A control's key without what a step sets on it, its value and states: the same control before and after. */
function identityKey(descriptor: TraceTargetDescriptor): string {
  const { value: _value, states: _states, ...control } = descriptor;
  return anchorKey(control);
}

/**
 * Whether some tier of a recorded anchor equals some projected node on every
 * anchor field, and on its value and states exactly: an empty field is not
 * the field filled in, nor an unchecked switch the switch turned on. An
 * alert is compared by its shape (`alertShape`).
 */
function anchorIn(anchor: TraceTargetDescriptor, nodes: readonly AnchorNode[]): boolean {
  const states = statesKey(anchor.states);
  const shape = isAlert(anchor) ? alertShape : (descriptor: TraceTargetDescriptor) => descriptor;
  return descriptorTiers(anchor).some((tier) =>
    nodes.some(
      (node) =>
        node.descriptor.value === anchor.value &&
        statesKey(node.descriptor.states) === states &&
        fieldsEqual(shape(tier), shape(node.descriptor), ANCHOR_FIELDS),
    ),
  );
}

/**
 * Anchor projections per observation: a replay checks the same end screen
 * once per poll and the start screen for every check, while the projection
 * of a node is a pure function of the node.
 */
const projections = new WeakMap<ReadonlyMap<string, RedactedNode>, readonly AnchorNode[]>();

/** Every node of an observation that can serve as an anchor, in document order. */
function projectAnchors(nodes: ReadonlyMap<string, RedactedNode>): readonly AnchorNode[] {
  const cached = projections.get(nodes);
  if (cached !== undefined) return cached;
  const anchors: AnchorNode[] = [];
  for (const node of nodes.values()) {
    const descriptor = anchorDescriptor(node);
    if (descriptor === undefined) continue;
    // An alert keyed by its shape: one whose countdown ticked while the step
    // ran stayed on screen, and is on neither side of the delta.
    const key = anchorKey(isAlert(descriptor) ? alertShape(descriptor) : descriptor);
    anchors.push({ descriptor, key, leaf: node.children === undefined || node.children.length === 0 });
  }
  projections.set(nodes, anchors);
  return anchors;
}

/** One node's anchor projection, or undefined when it could identify nothing. */
function anchorDescriptor(node: RedactedNode): TraceTargetDescriptor | undefined {
  const described = describeTarget(node);
  if (described === undefined || descriptorTiers(described).length === 0) return undefined;
  const { selector: _selector, ...anchor } = described;
  const states: TraceAnchorState[] = TRACE_ANCHOR_STATES.filter((state) => node.states?.[state] === true);
  const value = node.value === undefined || node.states?.secure === true ? '' : collapseText(node.value);
  return {
    ...anchor,
    ...(value === '' ? {} : { value: bound(value, MAX_TRACE_DESCRIPTOR_CHARS) }),
    ...(states.length === 0 ? {} : { states }),
  };
}

function statesKey(states: readonly TraceAnchorState[] | undefined): string {
  return states === undefined ? '' : states.join(',');
}

/**
 * Set key for one descriptor: its loosest identifying tier over the anchor
 * fields, in fixed order, and its states. Keying on the semantic tier
 * whenever it identifies the node means an app that mints test ids per
 * render cannot make every unchanged control look new after a re-render and
 * crowd the real effect out of the capped list; a node only a test id
 * identifies keeps it. The states make a control that changed state a node
 * of the delta on both sides: the switch as it was, gone, and as it is,
 * appeared; the value does the same for a field typed into.
 */
function anchorKey(descriptor: TraceTargetDescriptor): string {
  const tiers = descriptorTiers(descriptor);
  const loosest = tiers[tiers.length - 1] ?? descriptor;
  return JSON.stringify([...ANCHOR_FIELDS.map((field) => loosest[field]), descriptor.value, statesKey(descriptor.states)]);
}
