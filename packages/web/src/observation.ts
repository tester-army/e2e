/**
 * Semantic tree capture for one observation: the in-page walk, nested-document
 * stitching, and element-handle bookkeeping the surface keeps per generation.
 */

import type { ElementHandle, Frame, JSHandle } from 'playwright';
import {
  EngineError,
  sameSite,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  type NodeRef,
  type SemanticNode,
} from 'e2e/engine';
import {
  readDocumentSemanticsFunction,
  SECURE_FIELD_SELECTOR,
  type RawNodeData,
  type RawObservedNode,
} from './read-node.ts';
import { CaptureScope } from './capture-scope.ts';

/**
 * The id of every observation's root: the main document's element under one
 * id the engine mints, stable across observations and navigations, so the
 * harness can address the viewport (`perform(root, swipe)`) from an earlier
 * observation. Outside the `n<number>` space stamped ids and located ids share.
 */
export const ROOT_NODE_ID = 'root';

/** Nested iframe capture depth; deeper frames stay boundary nodes. */
const MAX_FRAME_DEPTH = 4;

/** Budget for capturing the main document, still capped by the observation deadline. */
const DOCUMENT_CAPTURE_TIMEOUT_MS = 15_000;

/**
 * Budget for capturing one child document. A stalled frame (ads, trackers)
 * must cost an observation a moment, not the context default timeout.
 */
const FRAME_CAPTURE_TIMEOUT_MS = 3_000;

/** A page or frame: anything one document's reader can be evaluated on. */
export type DocumentHost = Pick<Frame, 'evaluateHandle'>;

/** What one capture needs from the surface that owns the generation. */
export interface CaptureDeps {
  readonly testIdAttribute: string;
  /** The app's site; a child frame off it stays a boundary node. Undefined admits no child frame. */
  readonly site: string | undefined;
  /** Reserves a disjoint range before the reader can stamp any element, including on timeout. */
  reserveIds(count: number): number;
  /** Publishes one element handle under its id in the generation being built. */
  commit(id: string, element: ElementHandle<Element>): void;
}

export interface CaptureOptions {
  /** Enclosing frame selectors, outermost first; empty for the main document. */
  readonly framePath: readonly string[];
  /** Remaining node budget shared across every document of the observation. */
  readonly budget: number;
  /**
   * Absolute time (epoch ms) by which the whole observation must be done.
   * Every document's budget is derived from what remains of it, so the
   * documents of one observation can never sum past the operation's budget.
   */
  readonly deadline: number;
  readonly signal: AbortSignal;
}

/** One document's tree with what the capture knows about its completeness. */
export interface CapturedDocument {
  readonly tree: SemanticNode;
  /** Nodes captured across this document and every child document stitched in. */
  readonly nodeCount: number;
  /**
   * True when nodes on screen are missing from `tree`: the node budget cut
   * the walk short in this document or a child, or an on-site child frame's
   * document was not read (no budget or time left, past the depth limit, or
   * its capture failed). Off-site frames are left out by design and never
   * count.
   */
  readonly truncated: boolean;
}

/** One stored handle awaiting publication once its document captured successfully. */
type StagedRef = readonly [id: string, element: ElementHandle<Element>];

/**
 * Captures one document's semantic tree, then descends into each observed
 * iframe boundary node via its content frame and stitches the child
 * document under it. Frame capture is best-effort: a detached or unloaded
 * frame leaves its boundary node childless rather than failing the
 * observation. The node budget is shared across all documents.
 */
export async function captureDocument(
  deps: CaptureDeps,
  host: DocumentHost,
  options: CaptureOptions,
): Promise<CapturedDocument> {
  const { framePath, budget, signal } = options;
  const cap = framePath.length === 0 ? DOCUMENT_CAPTURE_TIMEOUT_MS : FRAME_CAPTURE_TIMEOUT_MS;
  const deadline = Math.min(options.deadline, Date.now() + cap);
  const scope = new CaptureScope(deadline, signal);
  // A child document's handles are published only once it captured whole; a
  // frame that fails midway leaves no reachable ids behind.
  const staged: StagedRef[] = [];
  const stage = (id: string, element: ElementHandle<Element>): void => {
    if (scope.own(element)) staged.push([id, element]);
  };
  return scope.run(async () => {
    const captured = await captureInto(deps, scope, stage, host, framePath, budget, signal);
    scope.check();
    for (const [id, element] of staged) {
      deps.commit(id, element);
      scope.release(element);
    }
    return captured;
  });
}

/** Reads one document and stages its child documents under the same capture owner. */
async function captureInto(
  deps: CaptureDeps,
  scope: CaptureScope,
  stage: (id: string, element: ElementHandle<Element>) => void,
  host: DocumentHost,
  framePath: readonly string[],
  budget: number,
  signal: AbortSignal,
): Promise<CapturedDocument> {
  const captured = await scope.read(() => host.evaluateHandle(readDocumentSemanticsFunction, {
    testIdAttribute: deps.testIdAttribute,
    secureFieldSelector: SECURE_FIELD_SELECTOR,
    mode: {
      kind: 'tree' as const,
      maxNodes: budget,
      idSeed: deps.reserveIds(budget),
      nameLimit: OBSERVED_NAME_LIMIT,
      textLimit: OBSERVED_TEXT_LIMIT,
    },
  }), (handle) => scope.own(handle));
  // Property handles would keep earlier captures alive after their parent is disposed.
  const { nodes, ids, truncated: walkTruncated } = await scope.read(() => captured.evaluate((observation) => ({
    nodes: observation.nodes,
    ids: observation.ids,
    truncated: observation.truncated,
  })));
  if (!Array.isArray(ids) || ids.length !== nodes.length) {
    throw new EngineError('ENGINE_FAILURE', 'observation ids do not align with its nodes', {
      retryable: false,
    });
  }
  // The main document's element is the observation root, under the minted
  // id rather than the one stamped on it: a new document stamps a new
  // number, the root's id must not change with it.
  if (framePath.length === 0 && ids.length > 0) ids[0] = ROOT_NODE_ID;
  const elementsHandle = await scope.read(() => captured.getProperty('elements'), (handle) => scope.own(handle));
  const elements = await collectElementHandles(scope, elementsHandle, nodes.length);
  elements.forEach((element, index) => stage(ids[index] as string, element));
  let nodeCount = nodes.length;
  let truncated = walkTruncated === true;
  const frameChildren = new Map<number, SemanticNode>();
  for (let index = 0; index < nodes.length; index += 1) {
    const selector = nodes[index]!.frameSelector;
    if (selector === undefined) continue;
    // A frame with no document (detached, never loaded) shows nothing, so
    // nothing is missing from the tree.
    const frame = await scope.read(() => elements[index]!.contentFrame().catch(() => null));
    if (frame === null) continue;
    // Only frames on the app's site enter observations. Third-party
    // frames (ads, trackers, embeds) are not the agent's to read or act
    // on - and a stalled ad frame must not tax the capture. They stay
    // boundary nodes by design, so leaving them out is not truncation.
    if (!isOnSiteFrame(frame.url(), deps.site)) continue;
    // From here the frame's document is content the model should see: any
    // reason it is not read (depth, budget, deadline, a failed or timed-out
    // capture) leaves the tree incomplete, and the snapshot must say so.
    if (framePath.length >= MAX_FRAME_DEPTH) {
      truncated = true;
      continue;
    }
    const remaining = budget - nodeCount;
    if (remaining <= 0 || Date.now() >= scope.deadline) {
      truncated = true;
      continue;
    }
    const child = await scope.read(() => captureDocument({ ...deps, commit: stage }, frame, {
      framePath: [...framePath, selector],
      budget: remaining,
      deadline: scope.deadline,
      signal,
    }).catch(() => undefined));
    if (child === undefined) {
      truncated = true;
      continue;
    }
    frameChildren.set(index, child.tree);
    nodeCount += child.nodeCount;
    truncated ||= child.truncated;
  }
  return { tree: assembleTree(nodes, ids, framePath, frameChildren), nodeCount, truncated };
}

/**
 * True when a frame document is on the app's site.
 *
 * `about:blank` and `srcdoc` documents inherit their parent's origin, so they
 * are the app's own content (consent managers, editors) and always allowed; the
 * parent frame was already admitted to be captured at all.
 *
 * A `data:` document is *not* admitted, even though its bytes are written by the
 * page that embeds it. It has an opaque origin rather than an inherited one, and
 * navigation denies the scheme by name alongside `file:` and `javascript:`.
 */
function isOnSiteFrame(url: string, site: string | undefined): boolean {
  if (url === '' || url === 'about:blank' || url === 'about:srcdoc') return true;
  if (site === undefined) return false;
  const protocol = URL.canParse(url) ? new URL(url).protocol : undefined;
  return protocol !== 'data:' && sameSite(url, site);
}

/**
 * Reads one element handle per observed node from the in-page element array.
 * `asElement` types handles as `ElementHandle<Node>`, but the observation walk
 * records `Element` nodes only, so the narrowing is safe by construction.
 */
async function collectElementHandles(
  scope: CaptureScope,
  elementsHandle: JSHandle,
  count: number,
): Promise<ElementHandle<Element>[]> {
  const properties = await scope.read(() => elementsHandle.getProperties(), (handles) => {
    for (const handle of handles.values()) scope.own(handle);
  });
  const elements: ElementHandle<Element>[] = [];
  for (let index = 0; index < count; index += 1) {
    const property = properties.get(String(index));
    const element = (property?.asElement() ?? null) as ElementHandle<Element> | null;
    if (element === null) {
      // The in-page array outlived its document (a navigation committed while
      // the handles were being read back). The capture is repeatable.
      throw new EngineError('NODE_STALE', `observation node ${index} lost its element`, {
        retryable: true,
      });
    }
    elements.push(element);
  }
  return elements;
}

/**
 * Rebuilds the observation tree from the depth-first node list. Descendants
 * always follow their parent, so children are complete before a parent is
 * built. Captured child documents attach under their iframe boundary nodes.
 */
function assembleTree(
  nodes: readonly RawObservedNode[],
  ids: readonly string[],
  framePath: readonly string[],
  frameChildren: ReadonlyMap<number, SemanticNode>,
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
    // A child document measured its nodes against its own viewport. Shifted by
    // the boundary element's box and clipped to it, every box in the tree is
    // in the top-level viewport's CSS pixels, the space the screenshot and a
    // point tap share, and a child that overflows its frame cannot claim a
    // point over the page around it. The shift is the frame's border box; a
    // bordered iframe is off by its border width, which is within a tap
    // target. A frame under a CSS transform is not unwound: its boxes are
    // where the untransformed frame would put them.
    if (embedded !== undefined) childLists[index]!.unshift(placeInFrame(embedded, raw.rect));
    const node = toSemanticNode({ id: ids[index]!, revision: '' }, raw, childLists[index]!, framePath);
    built[index] = node;
    if (raw.parent >= 0) childLists[raw.parent]!.unshift(node);
  }
  return built[0]!;
}

type Rect = NonNullable<SemanticNode['rect']>;

/** The tree with every box translated into the frame's space and clipped to its box; a box left empty by the clip is dropped. */
function placeInFrame(node: SemanticNode, frame: Rect): SemanticNode {
  const { rect, ...rest } = node;
  const placed = rect === undefined ? undefined : clipRect(offsetRect(rect, frame), frame);
  return {
    ...rest,
    ...(placed === undefined ? {} : { rect: placed }),
    ...(node.children === undefined ? {} : { children: node.children.map((child) => placeInFrame(child, frame)) }),
  };
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
    rect: raw.rect,
    ...(framePath.length > 0 ? { framePath } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}
