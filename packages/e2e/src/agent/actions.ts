/**
 * The committed-action model shared by everything that looks at what a step
 * did: one grammar action, addressed by the node it actually ran against,
 * described as a durable target descriptor plus redacted, bounded prose.
 *
 * The trace recorder stores the descriptor and the prose; the step event
 * carries the prose as `detail`; the relocator compares fresh nodes through
 * the same descriptor projection. One owner for all three, so a recorded
 * summary, a live event line, and a relocation candidate can never drift.
 */

import type { ViewportPoint, ViewportSize } from '../engine/surface.ts';
import { redactNode, type NodeRedaction, type RedactedNode } from './observation.ts';
import {
  isNodeAction,
  MAX_TRACE_DESCRIPTOR_CHARS,
  MAX_TRACE_SUMMARY_CHARS,
  targetLabel,
  type NodeActionName,
  type PointActionName,
  type TraceTargetDescriptor,
  type TracePosition,
} from '../cache/trace.ts';
import { sanitizeText } from '../internal/errors.ts';
import { bound, collapseText } from '../internal/text.ts';
import type { ScrollDirection } from '../types.ts';

/** One committed grammar action, addressed by the node it actually ran against. */
export type RecordableAction =
  | ({ readonly name: NodeActionName; readonly node: RedactedNode } & Placement)
  | ({ readonly name: 'type'; readonly node: RedactedNode; readonly value: string } & Placement)
  | ({ readonly name: 'typeSecret'; readonly node: RedactedNode; readonly secret: string } & Placement)
  | ({ readonly name: 'press'; readonly node: RedactedNode; readonly key: string } & Placement)
  | ({ readonly name: 'select'; readonly node: RedactedNode; readonly value: string } & Placement)
  | ({ readonly name: 'check'; readonly node: RedactedNode; readonly checked: boolean } & Placement)
  /** Project-relative paths as the executor gave them; replay authorizes them again. */
  | ({ readonly name: 'upload'; readonly node: RedactedNode; readonly paths: readonly string[] } & Placement)
  /** The dragged node with its placement, and where it was dropped, with its own. */
  | ({
      readonly name: 'drag';
      readonly node: RedactedNode;
      readonly destination: { readonly node: RedactedNode } & Placement;
    } & Placement)
  | ({
      readonly name: 'scroll';
      readonly direction: ScrollDirection;
      readonly node?: RedactedNode;
      /** The share of the viewport the node covered when scrolled, 0 to 1 (`ScrollAction.spans`). */
      readonly spans?: number;
    } & Placement)
  /** A list paged until a node reading `text` showed; the list as last paged, or none for the viewport. */
  | ({
      readonly name: 'scrollUntil';
      readonly text: string;
      readonly direction: ScrollDirection;
      readonly node?: RedactedNode;
      readonly spans?: number;
      /** How many pages it took; in the summary, never in the trace, since a replay pages for itself. */
      readonly screens: number;
    } & Placement)
  | { readonly name: 'navigate'; readonly url: string }
  | { readonly name: 'back' }
  /** Keyboard input to whatever held focus, with no node resolved. */
  | { readonly name: 'typeText'; readonly value: string; readonly replace: boolean }
  | { readonly name: 'pressKey'; readonly key: string }
  | { readonly name: 'dismissKeyboard' }
  /**
   * A tap or hover on a bare viewport point that no listed control
   * contained, with the viewport it was placed in and, when one is listed,
   * the node whose box contained it: the trace records the point's place
   * inside that box so replay can follow the node when the layout shifts.
   */
  | {
      readonly name: PointActionName;
      readonly point: ViewportPoint;
      readonly viewport: ViewportSize;
      readonly under?: RedactedNode;
    };

/** Where the node sat when it was acted on: its container's key and its place among identical twins. */
export interface Placement {
  readonly within?: string;
  readonly position?: TracePosition;
}


/** Roles whose first text names the thing a control belongs to: a row's key, a list item's title. */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['row', 'listitem', 'article', 'group', 'region', 'dialog', 'tabpanel']);
/** Longest container key kept. */
const MAX_WITHIN_CHARS = 80;

/**
 * The key of the nearest named container a node sits in, the first text of
 * its row or list item or else the container's own label, when that key says
 * more than the node's own name. Ten rows each with a "Delete" button are ten
 * identical descriptors; "Delete in the row that starts with Budget draft" is
 * one. A row whose only text is its own (`<li>Alpha <button><svg/></li>`)
 * is keyed by it. Only the nearest container counts: the list around a row
 * with no text names every row alike, so its key would tell no twin apart.
 * A container whose first text belongs to a twin of the row the node came
 * up through is such a list, and keys nothing by that text: a windowed list
 * renders whichever rows are near the viewport, so its first row is a scroll
 * position, not a place, and the same row would read as `Row 0512 in Row
 * 0500` one time and `in Row 0501` the next. Its own label still keys it.
 */
export function containerKey(
  id: string,
  nodes: ReadonlyMap<string, RedactedNode>,
  parents: ReadonlyMap<string, string>,
): string | undefined {
  const node = nodes.get(id);
  const own = node === undefined ? '' : squash(node.name ?? node.text ?? '');
  let came = id;
  let cursor = parents.get(id);
  while (cursor !== undefined) {
    const container = nodes.get(cursor);
    if (container !== undefined && CONTAINER_ROLES.has(container.role ?? '')) {
      const key = (namedAfterTwinOf(container, nodes.get(came)) ? undefined : firstLeafText(container)) ?? ownLabel(container);
      const clean = key === undefined ? '' : bound(collapseText(key), MAX_WITHIN_CHARS);
      return clean === '' || squash(clean) === own ? undefined : clean;
    }
    came = cursor;
    cursor = parents.get(cursor);
  }
  return undefined;
}

/**
 * Whether `container`'s first text sits in a child that is a container of
 * the same role as `branch`, the child the keyed node came up through, and
 * not `branch` itself: the container is then a list of such rows, named
 * after whichever one comes first.
 */
function namedAfterTwinOf(container: RedactedNode, branch: RedactedNode | undefined): boolean {
  if (branch === undefined || !CONTAINER_ROLES.has(branch.role ?? '')) return false;
  for (const child of container.children ?? []) {
    const own = (child.children?.length ?? 0) === 0 ? (child.text ?? child.name ?? '').trim() : '';
    if (own === '' && firstLeafText(child) === undefined) continue;
    return child.ref.id !== branch.ref.id && child.role === branch.role;
  }
  return false;
}

/** Parent id of every non-root node, derived from the tree the node map indexes. */
export function parentsOf(nodes: ReadonlyMap<string, RedactedNode>): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const node of nodes.values()) {
    for (const child of node.children ?? []) parents.set(child.ref.id, node.ref.id);
  }
  return parents;
}

/** The first leaf's own text under a container, depth-first. */
function firstLeafText(node: RedactedNode): string | undefined {
  for (const child of node.children ?? []) {
    const own = (child.children?.length ?? 0) === 0 ? (child.text ?? child.name ?? '').trim() : '';
    if (own !== '') return own;
    const deeper = firstLeafText(child);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/** A container's own name or text, when it has one. */
function ownLabel(node: RedactedNode): string | undefined {
  const label = (node.name ?? node.text ?? '').trim();
  return label === '' ? undefined : label;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** How one committed action reads back: where it acted, and what it did. */
export interface DescribedAction {
  /**
   * Durable descriptor of the target node; undefined for untargeted actions
   * and for nodes with nothing durable to re-find them by.
   */
  readonly target: TraceTargetDescriptor | undefined;
  /**
   * Redacted, bounded prose — `tap button "Approve"`, `fill secret
   * "password" into textbox "Password"`. Secret values never appear; the
   * secret's stable name stands in.
   */
  readonly summary: string;
  /** Where a drag was dropped, described like its target; only a drag has one. */
  readonly destination?: TraceTargetDescriptor;
}

/** How each node action reads, around the node it acted on: `tap button "Save"`, `scroll link "Terms" into view`. */
const NODE_ACTION_PROSE: Readonly<Record<NodeActionName, (where: string) => string>> = {
  tap: (where) => `tap ${where}`,
  doubleTap: (where) => `double-tap ${where}`,
  longPress: (where) => `long-press ${where}`,
  secondaryTap: (where) => `secondary-tap ${where}`,
  hover: (where) => `hover over ${where}`,
  scrollTo: (where) => `scroll ${where} into view`,
};

/** How each point verb reads: `tap the point (x, y)`, `hover over the point (x, y)`. */
const POINT_ACTION_PROSE: Readonly<Record<PointActionName, string>> = { tapAt: 'tap', hoverAt: 'hover over' };

/**
 * Describes one committed action for recording and for the live event. Its
 * nodes pass the ledger again as it is now: a secret resolved after the
 * capture (inside the action itself) masks what the capture still shows.
 */
export function describeAction(action: RecordableAction, redaction: NodeRedaction): DescribedAction {
  const target =
    'node' in action
      ? describePlaced(action.node, action, redaction)
      : 'point' in action
        ? describePlaced(action.under, {}, redaction)
        : undefined;
  const destination =
    action.name === 'drag' ? describePlaced(action.destination.node, action.destination, redaction) : undefined;
  const where = describeForSummary(target);
  const safe = (value: string) => quote(redaction.redact(sanitizeText(value)));
  const prose = (() => {
    if (isNodeAction(action)) return NODE_ACTION_PROSE[action.name](where);
    switch (action.name) {
      case 'type':
        return `type ${safe(action.value)} into ${where}`;
      case 'typeSecret':
        return `fill secret ${quote(action.secret)} into ${where}`;
      case 'press':
        return `press ${safe(action.key)} on ${where}`;
      case 'select':
        return `select ${safe(action.value)} in ${where}`;
      case 'check':
        return `${action.checked ? 'check' : 'uncheck'} ${where}`;
      case 'upload':
        return `upload ${action.paths.map(safe).join(', ')} to ${where}`;
      case 'drag':
        return `drag ${where} to ${describeForSummary(destination)}`;
      case 'scroll':
        return target === undefined ? `scroll ${action.direction}` : `scroll ${action.direction} on ${where}`;
      case 'scrollUntil': {
        const pages = action.screens === 0 ? 'already there' : `${String(action.screens)} ${action.screens === 1 ? 'screen' : 'screens'}`;
        return target === undefined
          ? `scroll ${action.direction} until ${safe(action.text)} shows (${pages})`
          : `scroll ${action.direction} on ${where} until ${safe(action.text)} shows (${pages})`;
      }
      case 'navigate':
        return `navigate to ${safe(action.url)}`;
      case 'back':
        return 'navigate back';
      case 'typeText':
        return `type ${safe(action.value)} into the focused field${action.replace ? ', replacing its value' : ''}`;
      case 'pressKey':
        return `press ${safe(action.key)} on the focused field`;
      case 'dismissKeyboard':
        return 'dismiss the keyboard';
      case 'tapAt':
      case 'hoverAt': {
        const at = `${POINT_ACTION_PROSE[action.name]} the point (${String(action.point.x)}, ${String(action.point.y)})`;
        return target === undefined ? at : `${at} on ${where}`;
      }
    }
  })();
  return {
    target,
    summary: bound(prose, MAX_TRACE_SUMMARY_CHARS),
    ...(destination === undefined ? {} : { destination }),
  };
}

/** A node's durable descriptor with the placement it was acted on in; undefined for no node or nothing durable. */
function describePlaced(
  node: RedactedNode | undefined,
  placement: Placement,
  redaction: NodeRedaction,
): TraceTargetDescriptor | undefined {
  if (node === undefined) return undefined;
  const { children: _children, ...fields } = node;
  const described = describeTarget(redactNode(fields, redaction));
  if (described === undefined) return undefined;
  return {
    ...described,
    ...(placement.within === undefined ? {} : { within: bound(redaction.redact(placement.within), MAX_WITHIN_CHARS) }),
    ...(placement.position === undefined ? {} : { position: placement.position }),
  };
}

/**
 * Builds the durable descriptor for one resolved node: the semantic fields
 * replay re-finds it by, plus the engine's structural selector hint (kept as
 * provenance for tuned policies; the conservative relocator ignores it).
 * Values a secure node holds are never part of it — descriptors carry how a
 * node is named, not what it contains. The node was redacted with its
 * observation (`redactNode`), each field in the one-line form read here too.
 */
export function describeTarget(node: RedactedNode): TraceTargetDescriptor | undefined {
  const field = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const collapsed = collapseText(value);
    return collapsed === '' ? undefined : bound(collapsed, MAX_TRACE_DESCRIPTOR_CHARS);
  };
  const role = field(node.role);
  const name = field(node.name);
  const text = field(node.text);
  const testId = field(node.testId);
  const placeholder = field(node.attributes?.['placeholder']);
  const selector = node.selector === undefined ? undefined : bound(node.selector, MAX_TRACE_DESCRIPTOR_CHARS);
  const inputPurpose =
    node.inputPurpose === undefined || node.inputPurpose === 'none' ? undefined : node.inputPurpose;
  const descriptor: TraceTargetDescriptor = {
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined || text === name ? {} : { text }),
    ...(testId === undefined ? {} : { testId }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(selector === undefined ? {} : { selector }),
    ...(inputPurpose === undefined ? {} : { inputPurpose }),
  };
  return Object.keys(descriptor).length === 0 ? undefined : descriptor;
}

function describeForSummary(target: TraceTargetDescriptor | undefined): string {
  const where = target === undefined ? 'the screen' : targetLabel(target);
  const placed = target?.within === undefined ? where : `${where} in ${JSON.stringify(bound(target.within, 40))}`;
  return target?.position === undefined
    ? placed
    : `${placed} (${target.position.index + 1} of ${target.position.of})`;
}


function quote(value: string): string {
  return JSON.stringify(bound(value, 40));
}
