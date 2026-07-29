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
} from '../driver/index.ts';
import type { NodeRect, SnapshotNode, SnapshotResult } from './client.ts';
import {
  deriveChecked,
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
 * Normalizes a backend ref to the form its commands accept.
 *
 * The snapshot JSON carries a bare `e12` while every interaction expects
 * `@e12`; a bare ref is parsed as a selector and rejected. Normalizing once at
 * projection keeps one spelling everywhere downstream.
 */
export function normalizeRef(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`;
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
    /** Labels carried anywhere below this node, filled by the recursion. */
    subtreeLabels: Set<string>,
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
    const area = node.rect === undefined ? 0 : node.rect.width * node.rect.height;
    const visible = node.visibleToUser !== false && area > 0;
    // A secure field's value never leaves the driver, per spec/16-mobile.md.
    const value = secure ? undefined : node.value;
    const editable = EDITABLE_ROLES.has(role) && node.enabled !== false;
    const projected: ProjectedNode = {
      ref: normalizeRef(node.ref),
      role,
      label: node.label,
      value,
      identifier: node.identifier,
      rect: node.rect,
      enabled: node.enabled !== false,
      visible,
      withinViewport: isWithinViewport(node.rect, viewport),
      covered: node.interactionBlocked === 'covered',
      focused: node.focused,
      selected: node.selected,
      checked: deriveChecked(role, value, node.selected),
      secure,
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
    const childLabels = new Set<string>();
    const kids = (children.get(node.index) ?? []).map((child) =>
      build(child, projected, childLabels),
    );
    // A label repeated on an ancestor belongs to the innermost carrier, which
    // is what web `getByText` resolves to.
    const own = queryText(projected);
    (projected as { ownsLabel: boolean }).ownsLabel =
      own !== undefined && !childLabels.has(own);
    for (const label of childLabels) subtreeLabels.add(label);
    if (own !== undefined) subtreeLabels.add(own);
    // `children` is readonly to consumers; it is filled here because a node
    // must exist before its children can reference it as their parent.
    (projected as { children: readonly ProjectedNode[] }).children = kids;
    return projected;
  };

  const roots = (children.get(undefined) ?? []).map((node) =>
    build(node, undefined, new Set<string>()),
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
 * The text a `text` query matches. Only the innermost carrier of a repeated
 * label matches, mirroring web, where an ancestor that contains text only
 * through its descendants is not a `getByText` match.
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
  const ref: NodeRef = { id: node.ref, revision };
  const nameLimit = options.bounded ? OBSERVED_NAME_LIMIT : Number.POSITIVE_INFINITY;
  const textLimit = options.bounded ? OBSERVED_TEXT_LIMIT : Number.POSITIVE_INFINITY;
  const states: Record<string, boolean> = {};
  if (!node.enabled) states['disabled'] = true;
  if (!node.visible) states['hidden'] = true;
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
    children: node.children.map((child) => toSemanticNode(child, revision, options)),
  };
}

/**
 * Wraps projected roots in one synthetic root, because `Observation.tree` is a
 * single node while a mobile snapshot can expose several window roots.
 */
export function toObservationTree(snapshot: ProjectedSnapshot): SemanticNode {
  const children = snapshot.roots.map((root) =>
    toSemanticNode(root, snapshot.revision, { bounded: true }),
  );
  if (children.length === 1 && children[0] !== undefined) return children[0];
  return {
    ref: { id: 'root', revision: snapshot.revision },
    role: 'application',
    children,
  };
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
