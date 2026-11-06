/**
 * Assembling one observation's semantic tree: nested-document stitching, frame
 * placement, and the node shape the contract reports.
 */

import {
  EngineError,
  sameSite,
  type NodeRef,
  type SemanticNode,
  type ViewportPoint,
} from 'e2e/engine';
import {
  type RawNodeData,
  type RawObservedNode,
} from './read-node.ts';

/**
 * The id of every observation's root: the main document's element under one
 * id the engine mints, stable across observations and navigations, so the
 * harness can address the viewport (`perform(root, swipe)`) from an earlier
 * observation. Outside the `n<number>` space stamped ids and located ids share.
 */
export const ROOT_NODE_ID = 'root';

/**
 * True when a frame document is on the app's site.
 *
 * `about:blank` and `srcdoc` documents inherit their parent's origin, so they
 * are the app's own content (consent managers, editors) and always allowed; the
 * parent frame was already admitted to be captured at all.
 *
 * A `data:` document is *not* admitted, even though its bytes are written by the
 * page that embeds it. It has an opaque origin rather than an inherited one, and
 * navigation admits only http(s) and `about:blank`.
 */
export function isOnSiteFrame(url: string, site: string | undefined): boolean {
  if (url === '' || url === 'about:blank' || url === 'about:srcdoc') return true;
  if (site === undefined) return false;
  const protocol = URL.canParse(url) ? new URL(url).protocol : undefined;
  return protocol !== 'data:' && sameSite(url, site);
}

/**
 * Rebuilds the observation tree from the depth-first node list. Descendants
 * always follow their parent, so children are complete before a parent is
 * built. Captured child documents attach under their iframe boundary nodes.
 */
export function assembleTree(
  nodes: readonly RawObservedNode[],
  ids: readonly string[],
  framePath: readonly string[],
  frameChildren: ReadonlyMap<number, FrameChild>,
): SemanticNode {
  if (nodes.length === 0 || ids.length === 0) {
    // An empty document is what a navigation in flight looks like; a real page
    // always has nodes, so the capture is worth repeating.
    throw new EngineError('NODE_STALE', 'observation produced no nodes', { retryable: true });
  }
  const childLists: SemanticNode[][] = nodes.map(() => []);
  const built: SemanticNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const raw = nodes[index]!;
    const embedded = frameChildren.get(index);
    // A child document measured its nodes against its own viewport, which
    // starts at the frame element's content box. Shifted by that box and
    // clipped to it, every box in the tree is in the top-level viewport's CSS
    // pixels, the space the screenshot and a point tap share, and a child that
    // overflows its frame cannot claim a point over the page around it. A
    // frame under a CSS transform is not unwound: its boxes are where the
    // untransformed frame would put them.
    if (embedded !== undefined && raw.rect !== null) {
      childLists[index]!.unshift(placeInFrame(embedded.tree, contentBox(raw.rect, embedded.inset)));
    }
    const node = toSemanticNode({ id: ids[index]!, revision: '' }, raw, childLists[index]!, framePath);
    built[index] = node;
    if (raw.parent >= 0) childLists[raw.parent]!.unshift(node);
  }
  return built[0]!;
}

type Rect = NonNullable<SemanticNode['rect']>;

/** A child document's tree, and where its viewport sits inside the frame element's border box. */
interface FrameChild {
  readonly tree: SemanticNode;
  readonly inset: Rect;
}

/**
 * Where a frame element's content box, the box its document's viewport
 * fills, sits inside its border box: past the border and the padding. Runs in
 * the page.
 */
export function frameContentInset(element: Element): Rect {
  const style = getComputedStyle(element);
  const left = Number.parseFloat(style.paddingLeft) || 0;
  const top = Number.parseFloat(style.paddingTop) || 0;
  const right = Number.parseFloat(style.paddingRight) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;
  return {
    x: element.clientLeft + left,
    y: element.clientTop + top,
    width: Math.max(0, element.clientWidth - left - right),
    height: Math.max(0, element.clientHeight - top - bottom),
  };
}

/** A frame element's content box, from its border box and `frameContentInset`. */
function contentBox(border: Rect, inset: Rect): Rect {
  return { x: border.x + inset.x, y: border.y + inset.y, width: inset.width, height: inset.height };
}

/** The tree with every box translated into the frame's space and clipped to its box; a box left empty by the clip is dropped. */
function placeInFrame(node: SemanticNode, frame: Rect): SemanticNode {
  const { rect, origin, ...rest } = node;
  return {
    ...rest,
    ...(rect === undefined ? {} : placeBoxInFrame(rect, origin, frame)),
    ...(node.children === undefined ? {} : { children: node.children.map((child) => placeInFrame(child, frame)) }),
  };
}

/**
 * A node box a child document measured against its own viewport, in the
 * top-level viewport's space: `rect` shifted by the frame's box and clipped
 * to it, empty when nothing of it is inside the frame. `origin` is shifted
 * but never clipped, and a clip that moves the box's corner keeps the
 * unclipped corner as `origin`, so an offset into the node lands where it
 * would at the top level.
 */
export function placeBoxInFrame(rect: Rect, origin: ViewportPoint | undefined, frame: Rect): Pick<SemanticNode, 'rect' | 'origin'> {
  const placed = clipRect(offsetRect(rect, frame), frame);
  if (placed === undefined) return {};
  const corner = origin ?? rect;
  const shifted = { x: corner.x + frame.x, y: corner.y + frame.y };
  return shifted.x === placed.x && shifted.y === placed.y ? { rect: placed } : { rect: placed, origin: shifted };
}

function offsetRect(rect: Rect, by: Rect): Rect {
  return { x: rect.x + by.x, y: rect.y + by.y, width: rect.width, height: rect.height };
}

function clipRect(rect: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

export function toSemanticNode(
  ref: NodeRef,
  raw: RawNodeData,
  children: readonly SemanticNode[] = [],
  framePath: readonly string[] = [],
): SemanticNode {
  const states: Record<string, boolean> = {};
  if (raw.states.checked !== null) states['checked'] = raw.states.checked;
  if (raw.states.disabled) states['disabled'] = true;
  if (raw.states.selected !== null) states['selected'] = raw.states.selected;
  if (raw.states.expanded !== null) states['expanded'] = raw.states.expanded;
  if (raw.states.pressed !== null) states['pressed'] = raw.states.pressed;
  if (raw.states.focused) states['focused'] = true;
  if (raw.states.hidden) states['hidden'] = true;
  if (raw.states.secure) states['secure'] = true;
  return {
    ref,
    ...(raw.role !== null ? { role: raw.role } : {}),
    ...(raw.name !== null ? { name: raw.name } : {}),
    ...(raw.text !== null ? { text: raw.text } : {}),
    ...(raw.value !== null ? { value: raw.value } : {}),
    ...(raw.selection !== null ? { selection: raw.selection } : {}),
    ...(raw.testId !== null ? { testId: raw.testId } : {}),
    inputPurpose: raw.inputPurpose,
    states,
    ...(raw.level !== null ? { level: raw.level } : {}),
    attributes: raw.attributes,
    ...(raw.rect !== null ? { rect: raw.rect } : {}),
    ...(raw.origin !== null ? { origin: raw.origin } : {}),
    ...(framePath.length > 0 ? { framePath } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}
