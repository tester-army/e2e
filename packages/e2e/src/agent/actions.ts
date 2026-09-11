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

import type { SemanticNode, ViewportPoint } from '../engine/surface.ts';
import {
  bound,
  MAX_TRACE_DESCRIPTOR_CHARS,
  MAX_TRACE_SUMMARY_CHARS,
  type TraceTargetDescriptor,
  type TracePosition,
} from '../cache/trace.ts';
import { sanitizeText } from '../internal/errors.ts';
import { normalizeText } from '../internal/text.ts';
import type { ScrollDirection } from '../types.ts';

/** One committed grammar action, addressed by the node it actually ran against. */
export type RecordableAction =
  | ({ readonly name: 'tap'; readonly node: SemanticNode } & Placement)
  | ({ readonly name: 'type'; readonly node: SemanticNode; readonly value: string } & Placement)
  | ({ readonly name: 'typeSecret'; readonly node: SemanticNode; readonly secret: string } & Placement)
  | ({ readonly name: 'press'; readonly node: SemanticNode; readonly key: string } & Placement)
  | ({ readonly name: 'select'; readonly node: SemanticNode; readonly value: string } & Placement)
  | ({ readonly name: 'scroll'; readonly direction: ScrollDirection; readonly node?: SemanticNode } & Placement)
  | { readonly name: 'navigate'; readonly url: string }
  /**
   * A tap on a bare viewport point that no listed control contained, with
   * the viewport it was placed in and, when one is listed, the node whose
   * box contained it: the trace records the point's place inside that box
   * so replay can follow the node when the layout shifts.
   */
  | {
      readonly name: 'tapAt';
      readonly point: ViewportPoint;
      readonly viewport: { readonly width: number; readonly height: number };
      readonly under?: SemanticNode;
    };

/** Where the node sat when it was acted on: its container's key and its place among identical twins. */
interface Placement {
  readonly within?: string;
  readonly position?: TracePosition;
}

/** Roles whose first text names the thing a control belongs to: a row's key, a list item's title. */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['row', 'listitem', 'article', 'group', 'region', 'dialog', 'tabpanel']);
/** Longest container key kept. */
const MAX_WITHIN_CHARS = 80;

/**
 * The key of the nearest named container a node sits in — the first text of
 * its row or list item — when that key says more than the node's own name.
 * Ten rows each with a "Delete" button are ten identical descriptors; "Delete
 * in the row that starts with Budget draft" is one.
 */
export function containerKey(
  id: string,
  nodes: ReadonlyMap<string, SemanticNode>,
  parents: ReadonlyMap<string, string>,
  redact: (text: string) => string,
): string | undefined {
  const node = nodes.get(id);
  const own = node === undefined ? '' : squash(node.name ?? node.text ?? '');
  let cursor = parents.get(id);
  while (cursor !== undefined) {
    const container = nodes.get(cursor);
    if (container !== undefined && CONTAINER_ROLES.has(container.role ?? '')) {
      const key = firstLeafText(container);
      if (key !== undefined) {
        const clean = bound(redact(sanitizeText(key)).replace(/\s+/g, ' ').trim(), MAX_WITHIN_CHARS);
        return clean === '' || squash(clean) === own ? undefined : clean;
      }
      return undefined;
    }
    cursor = parents.get(cursor);
  }
  return undefined;
}

/** Parent id of every non-root node, derived from the tree the node map indexes. */
export function parentsOf(nodes: ReadonlyMap<string, SemanticNode>): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const node of nodes.values()) {
    for (const child of node.children ?? []) parents.set(child.ref.id, node.ref.id);
  }
  return parents;
}

/** The first leaf's own text under a container, depth-first. */
function firstLeafText(node: SemanticNode): string | undefined {
  for (const child of node.children ?? []) {
    const own = (child.children?.length ?? 0) === 0 ? (child.text ?? child.name ?? '').trim() : '';
    if (own !== '') return own;
    const deeper = firstLeafText(child);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
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
}

/** Describes one committed action for recording and for the live event. */
export function describeAction(
  action: RecordableAction,
  redact: (text: string) => string,
  testIdAttribute: string,
): DescribedAction {
  const node = 'node' in action ? action.node : action.name === 'tapAt' ? action.under : undefined;
  const within = 'within' in action ? action.within : undefined;
  const position = 'position' in action ? action.position : undefined;
  const described = node === undefined ? undefined : describeTarget(node, redact, testIdAttribute);
  const target =
    described === undefined
      ? undefined
      : {
          ...described,
          ...(within === undefined ? {} : { within: bound(within, MAX_WITHIN_CHARS) }),
          ...(position === undefined ? {} : { position }),
        };
  const where = describeForSummary(target);
  const safe = (value: string) => quote(redact(sanitizeText(value)));
  const prose = (() => {
    switch (action.name) {
      case 'tap':
        return `tap ${where}`;
      case 'type':
        return `type ${safe(action.value)} into ${where}`;
      case 'typeSecret':
        return `fill secret ${quote(action.secret)} into ${where}`;
      case 'press':
        return `press ${safe(action.key)} on ${where}`;
      case 'select':
        return `select ${safe(action.value)} in ${where}`;
      case 'scroll':
        return target === undefined ? `scroll ${action.direction}` : `scroll ${action.direction} on ${where}`;
      case 'navigate':
        return `navigate to ${safe(action.url)}`;
      case 'tapAt': {
        const at = `tap the point (${String(action.point.x)}, ${String(action.point.y)})`;
        return target === undefined ? at : `${at} on ${where}`;
      }
    }
  })();
  return { target, summary: bound(prose, MAX_TRACE_SUMMARY_CHARS) };
}

/**
 * Builds the durable descriptor for one resolved node: the semantic fields
 * replay re-finds it by, plus the engine's structural selector hint (kept as
 * provenance for tuned policies; the conservative relocator ignores it).
 * Values a secure node holds are never part of it — descriptors carry how a
 * node is named, not what it contains.
 */
export function describeTarget(
  node: SemanticNode,
  redact: (text: string) => string,
  testIdAttribute: string,
): TraceTargetDescriptor | undefined {
  const field = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const collapsed = normalizeText(redact(sanitizeText(value)));
    return collapsed === '' ? undefined : bound(collapsed, MAX_TRACE_DESCRIPTOR_CHARS);
  };
  const role = field(node.role);
  const name = field(node.name);
  const text = field(node.text);
  const testId = field(node.attributes?.[testIdAttribute]);
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
  const where = describeWhere(target);
  const placed = target?.within === undefined ? where : `${where} in ${JSON.stringify(bound(target.within, 40))}`;
  return target?.position === undefined
    ? placed
    : `${placed} (${target.position.index + 1} of ${target.position.of})`;
}

function describeWhere(target: TraceTargetDescriptor | undefined): string {
  if (target === undefined) return 'the screen';
  const label = target.name ?? target.text ?? target.placeholder ?? target.testId ?? '';
  const role = target.role ?? 'node';
  return label === '' ? role : `${role} ${JSON.stringify(bound(label, 40))}`;
}

function quote(value: string): string {
  return JSON.stringify(bound(value, 40));
}
