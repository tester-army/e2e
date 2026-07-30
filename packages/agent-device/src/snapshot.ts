/**
 * Projects an agent-device snapshot onto the `driver-1` semantic tree.
 *
 * agent-device returns a flat node array addressed by `index`/`parentIndex`;
 * `driver-1` wants a nested tree of `SemanticNode`. This module owns that
 * conversion plus the projection rules of spec/16-mobile.md: role
 * normalization, query-source mapping, state derivation, secure masking, and
 * revision binding.
 */

import {
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  type NodeRef,
  type SemanticNode,
} from 'e2e/driver';
import type { NodeRect, SnapshotNode, SnapshotResult } from './client.ts';
import {
  deriveChecked,
  isInteractiveRole,
  isScrollContainer,
  normalizeRole,
  roleKey,
  type MobilePlatform,
  type MobileRole,
} from './roles.ts';

/** One projected node, retaining the mobile fields the driver acts on. */
export interface ProjectedNode {
  readonly ref: string;
  readonly role: MobileRole;
  readonly label: string | undefined;
  readonly value: string | undefined;
  readonly identifier: string | undefined;
  /**
   * The node is the innermost carrier of its label. iOS repeats an
   * accessibility label on every ancestor wrapper, so only the innermost owns
   * it for text and label queries.
   */
  readonly ownsLabel: boolean;
  readonly rect: NodeRect | undefined;
  readonly enabled: boolean;
  readonly visible: boolean;
  /** The action point lies inside the device viewport. */
  readonly withinViewport: boolean;
  /** The backend reported another element covering this one. */
  readonly covered: boolean;
  readonly focused: boolean | undefined;
  readonly selected: boolean | undefined;
  readonly checked: boolean | undefined;
  readonly secure: boolean;
  /**
   * Character count of the field's current value, kept even for a secure field
   * whose value is masked, because clearing needs one delete per character. It
   * never leaves the driver.
   */
  readonly valueLength: number;
  readonly inputPurpose: SemanticNode['inputPurpose'] | undefined;
  readonly editable: boolean;
  readonly scrollContainer: boolean;
  readonly children: readonly ProjectedNode[];
  readonly parent: ProjectedNode | undefined;
}

/** A projected snapshot: its revision, its roots, and a ref index. */
export interface ProjectedSnapshot {
  readonly revision: string;
  readonly roots: readonly ProjectedNode[];
  /** Every node in platform document order. */
  readonly ordered: readonly ProjectedNode[];
  readonly byRef: ReadonlyMap<string, ProjectedNode>;
  readonly secureVisible: boolean;
  /** Device viewport in points, taken from the root geometry. */
  readonly viewport: { readonly width: number; readonly height: number } | undefined;
}

/**
 * Canonical node id: the backend ref without its `@` sigil.
 *
 * The sigil is an agent-device wire detail, not part of the node's identity. It
 * matters because a node id is printed into the model's observation as `#id`,
 * and `#@e12` reads as two sigils: models drop the `@` and their answer is then
 * rejected as a node that is not in the observation.
 */
export function canonicalRef(ref: string): string {
  return ref.startsWith('@') ? ref.slice(1) : ref;
}

/** The ref spelling the backend's commands require. */
export function clientRef(node: Pick<ProjectedNode, 'ref'>): string {
  return `@${node.ref}`;
}

/** iOS secure text entry, and the Android password input-type markers. */
const SECURE_TYPE_KEYS: ReadonlySet<string> = new Set(['secure-text-field']);
const PASSWORD_HINT = /password|textpassword|numberpassword|visiblepassword/i;

const EDITABLE_ROLES: ReadonlySet<MobileRole> = new Set(['textbox', 'searchbox']);

function isSecure(node: SnapshotNode): boolean {
  for (const candidate of [node.role, node.subrole, node.type]) {
    if (candidate !== undefined && SECURE_TYPE_KEYS.has(roleKey(candidate))) return true;
  }
  const hints = node.presentationHints;
  if (hints !== undefined && hints.some((hint) => PASSWORD_HINT.test(hint))) return true;
  return false;
}

/**
 * Derives `inputPurpose` from platform signals, per spec/16-mobile.md. Only a
 * proven signal produces a purpose; everything else is `none`.
 */
function deriveInputPurpose(
  node: SnapshotNode,
  secure: boolean,
  editable: boolean,
): SemanticNode['inputPurpose'] | undefined {
  if (!editable && !secure) return undefined;
  const hints = (node.presentationHints ?? []).join(' ').toLowerCase();
  if (/one-?time-?code|otp|sms-?code/.test(hints)) return 'one-time-code';
  if (secure) return 'password';
  if (/username|email-?address/.test(hints)) return 'username';
  return 'none';
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Builds the projected tree. Platform order is preserved: nodes keep the
 * backend's array order, which spec/16-mobile.md defines as document order.
 */
export function projectSnapshot(
  snapshot: SnapshotResult,
  platform: MobilePlatform,
  revision: string,
): ProjectedSnapshot {
  const nodes = snapshot.nodes;
  const byIndex = new Map<number, SnapshotNode>();
  for (const node of nodes) byIndex.set(node.index, node);

  const children = new Map<number | undefined, SnapshotNode[]>();
  for (const node of nodes) {
    // A parent reference that is not in this snapshot makes the node a root,
    // so a partial capture never silently drops a subtree.
    const parentIndex =
      node.parentIndex !== undefined && byIndex.has(node.parentIndex) ? node.parentIndex : undefined;
    const siblings = children.get(parentIndex);
    if (siblings === undefined) children.set(parentIndex, [node]);
    else siblings.push(node);
  }

  const ordered: ProjectedNode[] = [];
  const byRef = new Map<string, ProjectedNode>();
  let secureVisible = false;
  // The screen is the root's geometry, and it is the only reliable source of
  // viewport bounds: no mobile target configures a viewport.
  const viewport = rootBounds(nodes, children.get(undefined) ?? []);

  const build = (
    node: SnapshotNode,
    parent: ProjectedNode | undefined,
    /** Labels owned anywhere below this node, filled by the recursion. */
    /** Labels carried by this node's ancestors, for outermost-wins ownership. */
    ancestorLabels: ReadonlySet<string>,
    /** Nearest ancestor rect that passed the consistency check. */
    trustedAncestorRect: NodeRect | undefined,
  ): ProjectedNode => {
    const secure = isSecure(node);
    const role = normalizeRole(node, platform, {
      ...(node.selected !== undefined ? { checkable: true } : {}),
      ...(parent !== undefined ? { parentRole: parent.role } : {}),
    });
    // Geometry decides visibility. iOS omits a visibility flag entirely and its
    // hittability flag is false for plainly tappable controls, so a flag-based
    // gate would hide the whole UI. Scroll position does not affect visibility,
    // matching web, where an element below the fold is still visible.
    const rect = usableRect(node.rect, trustedAncestorRect);
    const visible = node.visibleToUser !== false && rect !== undefined;
    // A secure field's value never leaves the driver, per spec/16-mobile.md.
    const value = secure ? undefined : node.value;
    const editable = EDITABLE_ROLES.has(role) && node.enabled !== false;
    const projected: ProjectedNode = {
      ref: canonicalRef(node.ref),
      role,
      label: node.label,
      value,
      identifier: node.identifier,
      rect,
      enabled: node.enabled !== false,
      visible,
      withinViewport: isWithinViewport(rect, viewport),
      covered: node.interactionBlocked === 'covered',
      focused: node.focused,
      selected: node.selected,
      checked: deriveChecked(role, value, node.selected),
      secure,
      valueLength: node.value?.length ?? 0,
      inputPurpose: deriveInputPurpose(node, secure, editable),
      editable,
      scrollContainer: isScrollContainer(node),
      // Filled after the children are built, which is when duplication is known.
      ownsLabel: true,
      children: [],
      parent,
    };
    if (secure && visible) secureVisible = true;
    ordered.push(projected);
    byRef.set(projected.ref, projected);
    // A label repeated down a chain belongs to its outermost carrier: iOS copies
    // a row's label onto every wrapper inside it, and the row is the thing the
    // user sees and taps. The inner copies are one control's internals, not
    // separate targets. Only a node with usable geometry can own a label, since
    // iOS zeroes the rects of a scrolled-away row's descendants and one of those
    // claiming the label would make the row unmatchable.
    const own = queryText(projected);
    const owns = own !== undefined && rect !== undefined && !ancestorLabels.has(own);
    (projected as { ownsLabel: boolean }).ownsLabel = owns;

    // A scroll container's content legitimately extends past its own frame, so
    // it imposes no containment on its children. Any other view does: its
    // subviews are inside it.
    const boundsForChildren = projected.scrollContainer ? undefined : rect ?? trustedAncestorRect;
    const labelsForChildren =
      own === undefined ? ancestorLabels : new Set([...ancestorLabels, own]);
    const kids = (children.get(node.index) ?? []).map((child) =>
      build(child, projected, labelsForChildren, boundsForChildren),
    );
    // `children` is readonly to consumers; it is filled here because a node
    // must exist before its children can reference it as their parent.
    (projected as { children: readonly ProjectedNode[] }).children = kids;
    return projected;
  };

  const roots = (children.get(undefined) ?? []).map((node) =>
    build(node, undefined, new Set<string>(), undefined),
  );
  return { revision, roots, ordered, byRef, secureVisible, viewport };
}

/** Screen bounds, taken from the largest root rect the snapshot exposes. */
function rootBounds(
  nodes: readonly SnapshotNode[],
  roots: readonly SnapshotNode[],
): { readonly width: number; readonly height: number } | undefined {
  let width = 0;
  let height = 0;
  for (const root of roots.length > 0 ? roots : nodes) {
    const rect = root.rect;
    if (rect === undefined) continue;
    width = Math.max(width, Math.round(rect.x + rect.width));
    height = Math.max(height, Math.round(rect.y + rect.height));
  }
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Returns a rect only when it can be trusted.
 *
 * A rect must enclose some area, and must intersect the bounds its ancestors
 * impose. iOS reports stale geometry for the descendants of a cell scrolled out
 * of the viewport: it places them where the row used to be, far outside their
 * own parent, and zeroes the innermost ones. Believing that makes an
 * unreachable node look reachable and hands the row's label to a node that
 * cannot be seen or tapped, so inconsistent geometry counts as none at all.
 *
 * A scroll container imposes no bounds on its children, because a row scrolled
 * below the fold is genuinely outside its container's frame while still being
 * real.
 */
function usableRect(
  rect: NodeRect | undefined,
  trustedAncestorRect: NodeRect | undefined,
): NodeRect | undefined {
  if (rect === undefined || rect.width <= 0 || rect.height <= 0) return undefined;
  if (trustedAncestorRect === undefined) return rect;
  return intersects(rect, trustedAncestorRect) ? rect : undefined;
}

function intersects(a: NodeRect, b: NodeRect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/** Reports whether a rect's center lies inside the viewport. */
function isWithinViewport(
  rect: NodeRect | undefined,
  viewport: { readonly width: number; readonly height: number } | undefined,
): boolean {
  if (rect === undefined) return false;
  // Without known bounds the driver cannot prove the point is off-screen, and
  // refusing every action would be worse than trusting the backend.
  if (viewport === undefined) return true;
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
}

/** The text a node carries: its label, else its value. */
export function queryText(node: ProjectedNode): string | undefined {
  return node.label ?? node.value;
}

/**
 * The text a `text` query matches: only the outermost carrier of a repeated
 * label, which is the row a user sees rather than one of its internals.
 */
export function ownedText(node: ProjectedNode): string | undefined {
  return node.ownsLabel ? queryText(node) : undefined;
}

/** The label a `label` query matches, under the same ownership rule. */
export function ownedLabel(node: ProjectedNode): string | undefined {
  return node.ownsLabel ? node.label : undefined;
}

/**
 * The text a `placeholder` query matches. Per spec/16-mobile.md this is the
 * label of an empty textbox or searchbox, which is how both platforms expose a
 * placeholder or hint; a field holding a value has no placeholder.
 */
export function queryPlaceholder(node: ProjectedNode): string | undefined {
  if (node.role !== 'textbox' && node.role !== 'searchbox') return undefined;
  if (node.value !== undefined && node.value !== '') return undefined;
  return node.label;
}

/**
 * Converts one projected node to its wire `SemanticNode`, including children.
 * Observation trees are bounded per field; single-node reads are not, so
 * `read` passes `bounded: false`.
 */
export function toSemanticNode(
  node: ProjectedNode,
  revision: string,
  options: { readonly bounded: boolean },
): SemanticNode {
  return {
    ...nodeFields(node, revision, options.bounded),
    children: node.children.map((child) => toSemanticNode(child, revision, options)),
  };
}

/**
 * Every wire field of one node except its children.
 *
 * `bounded` marks an observation, whose per-field limits keep a model prompt
 * affordable. A direct read is unbounded and carries whole values.
 */
function nodeFields(
  node: ProjectedNode,
  revision: string,
  bounded: boolean,
): Omit<SemanticNode, 'children'> {
  const options = { bounded };
  const ref: NodeRef = { id: node.ref, revision };
  const nameLimit = options.bounded ? OBSERVED_NAME_LIMIT : Number.POSITIVE_INFINITY;
  const textLimit = options.bounded ? OBSERVED_TEXT_LIMIT : Number.POSITIVE_INFINITY;
  const states: Record<string, boolean> = {};
  if (!node.enabled) states['disabled'] = true;
  if (!node.visible) states['hidden'] = true;
  // Visible but out of reach: the runner scrolls rather than dispatching, and
  // the model is told why the node cannot be tapped yet.
  if (node.visible && !node.withinViewport) states['offscreen'] = true;
  if (node.selected === true) states['selected'] = true;
  if (node.focused === true) states['focused'] = true;
  if (node.checked !== undefined) states['checked'] = node.checked;
  if (node.secure) states['secure'] = true;

  const name = truncate(node.label, nameLimit);
  const text = truncate(queryText(node), textLimit);
  const value = truncate(node.value, textLimit);
  return {
    ref,
    role: node.role,
    ...(name !== undefined ? { name } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(node.inputPurpose !== undefined ? { inputPurpose: node.inputPurpose } : {}),
    ...(Object.keys(states).length > 0 ? { states } : {}),
    ...(node.identifier !== undefined ? { attributes: { testId: node.identifier } } : {}),
    ...(node.rect !== undefined ? { rect: { ...node.rect } } : {}),
  };
}

/**
 * Wraps projected roots in one synthetic root, because `Observation.tree` is a
 * single node while a mobile snapshot can expose several window roots.
 */
export function toObservationTree(snapshot: ProjectedSnapshot): SemanticNode {
  const children = snapshot.roots.flatMap((root) => observedNodes(root, snapshot.revision));
  if (children.length === 1 && children[0] !== undefined) return children[0];
  return {
    ref: { id: 'root', revision: snapshot.revision },
    role: 'application',
    children,
  };
}

/**
 * Reports whether a node carries meaning for an observation.
 *
 * A mobile tree is dominated by layout wrappers: a single Settings row nests
 * four `generic` nodes that only repeat the row's own label. Sending them costs
 * tokens and asks the model to choose between identical candidates, so a
 * wrapper that contributes no role, no owned label, and no identifier is
 * collapsed and its children are promoted. Every node the model can act on is
 * kept, so refs stay resolvable.
 */
function isObservable(node: ProjectedNode): boolean {
  // A control is always kept: it is the only node carrying its role, a role
  // query addresses it, and a container above it may well repeat its label.
  if (isInteractiveRole(node.role)) return true;
  if (node.identifier !== undefined) return true;
  // Otherwise a node carrying a label it does not own is an inner copy of its
  // row, and a derived query resolves that label to the owner instead, so the
  // copy could not be addressed.
  if (queryText(node) !== undefined) return node.ownsLabel;
  // An unnamed, unaddressable container carries nothing a model can use.
  return false;
}

/** Projects one subtree, promoting the children of collapsed wrappers. */
function observedNodes(node: ProjectedNode, revision: string): SemanticNode[] {
  const children = node.children.flatMap((child) => observedNodes(child, revision));
  if (!isObservable(node)) return children;
  return [{ ...nodeFields(node, revision, true), children }];
}

/**
 * The node input actually reaches for a selected node.
 *
 * A platform may expose one control as nested nodes that share a role: iOS
 * wraps a switch in a same-role container spanning the whole row, whose center
 * lies on the row label and receives no input at all. The control is the
 * innermost descendant that shares the node's role and covers less area. This
 * picks a point inside the selected node rather than substituting a different
 * node, so it is not retargeting.
 */
export function controlOf(node: ProjectedNode): ProjectedNode {
  let control = node;
  for (;;) {
    const inner = control.children.find(
      (child) => child.role === control.role && area(child) > 0 && area(child) < area(control),
    );
    if (inner === undefined) return control;
    control = inner;
  }
}

function area(node: ProjectedNode): number {
  const rect = node.rect;
  return rect === undefined ? 0 : rect.width * rect.height;
}

/**
 * Nearest scrollable ancestor of a node, or undefined when none scrolls, which
 * means `scrollUntilVisible` scrolls the viewport instead.
 */
export function nearestScrollContainer(node: ProjectedNode): ProjectedNode | undefined {
  let current = node.parent;
  while (current !== undefined) {
    if (current.scrollContainer) return current;
    current = current.parent;
  }
  return undefined;
}
