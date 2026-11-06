/**
 * Nested documents on the BiDi driver. An iframe's document is its own
 * browsing context, reached through the iframe element's `contentWindow`;
 * the surface remembers, for each child context it entered, the iframe
 * element that holds it, so a box measured inside the child can be placed in
 * the top-level viewport the pointer and the screenshot share.
 */

import { EngineError, TestError, type LocatorExpression, type SemanticNode } from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_KEY } from '../closed-shadow.ts';
import { frameContentInset } from '../observation.ts';
import type { BidiConnection } from './connection.ts';
import { ChromiumCdp } from './cdp.ts';
import { callFunction, ElementRef, WindowRef } from './script.ts';
import type { BidiBrowserName } from './launch.ts';
import { compose, IDENTITY, invert, rectToQuad, scaleThenTranslate, type Projection } from './projection.ts';
import { chainParts, cssChains, type CssStep } from './selector-tokens.ts';

/** An element and the browsing context whose document holds it. */
export interface NodeTarget {
  readonly element: ElementRef;
  readonly context: string;
  /** The expression that located the element as its only match, which an action checks still matches it alone. */
  readonly locator?: LocatorExpression;
}

type Rect = NonNullable<SemanticNode['rect']>;

type Point = { readonly x: number; readonly y: number };

/** One iframe as its document lays it out: its content box, and the scale from the document inside it to that box. */
interface FrameStep {
  readonly content: Rect;
  readonly scale: Point;
}

/** A frame's viewport in the top-level one: where its coordinates start, how much they scale, and the part of it its holders show. */
export interface FrameView {
  readonly origin: Point;
  readonly scale: Point;
  readonly clip: Rect;
}

/** A rect in a frame's viewport, in the viewport `view` places that frame's in. */
function toParent(rect: Rect, view: Pick<FrameView, 'origin' | 'scale'>): Rect {
  return { x: view.origin.x + rect.x * view.scale.x, y: view.origin.y + rect.y * view.scale.y, width: rect.width * view.scale.x, height: rect.height * view.scale.y };
}

/** `rect` cut to `bounds`; undefined when nothing of it is inside. */
function clipTo(rect: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** An iframe element's window, which serializes as its browsing context. Runs in the page. */
function contentWindow(element: HTMLIFrameElement): Window | null {
  return element.contentWindow;
}

/** The child browsing context of an iframe element, or undefined when it has no document. */
export async function contentContext(connection: BidiConnection, frame: NodeTarget): Promise<string | undefined> {
  const window = await callFunction(connection, frame.context, contentWindow, [frame.element]);
  return window instanceof WindowRef ? window.context : undefined;
}

/** One `>>` chain part as the page reads it: CSS as its complex selectors (`cssChains`), or an XPath expression. */
export type PagePart =
  | { readonly engine: 'css'; readonly body: string; readonly chains: CssStep[][] }
  | { readonly engine: 'xpath'; readonly body: string };

/**
 * The `>>` chain parts of `selector` as the page reads them. Only the CSS and
 * XPath engines are supported, and only the last part may capture; anything
 * else is `INVALID_LOCATOR`.
 */
export function pageParts(selector: string): PagePart[] {
  const parts = chainParts(selector);
  if (parts.slice(0, -1).some((part) => part.capture)) {
    throw new TestError('INVALID_LOCATOR', 'a selector that captures with * (*css=article >> text=Hello) is not supported: use filter({ has }) instead');
  }
  return parts.map((part): PagePart => {
    if (part.engine === 'css') return { engine: 'css', body: part.body, chains: cssChains(part.body) };
    if (part.engine === 'xpath') return { engine: 'xpath', body: part.body };
    throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: the ${part.engine}= engine is not supported`);
  });
}

/** The sandbox realm selectors run in, so a page that replaced a built-in (`window.Map = 1`) cannot break them. */
const SELECTOR_SANDBOX = 'e2e-selectors';

/** One element a selector matched, and its tag name. */
export interface SelectedElement {
  readonly element: ElementRef;
  readonly localName: string;
}

/**
 * The elements a `>>` chain (`pageParts`) matches, each part evaluated inside
 * every element the part before it matched, as Playwright's engines read it.
 * CSS pierces open shadow roots: the last compound is queried natively in the
 * scope and in each shadow root under it, and the compounds before it are
 * matched right to left up the composed tree, memoized per element and
 * compound, with every combinator stopping at the scope element, which only a
 * `:scope` compound matches. XPath stays in the light DOM, a leading `/` read
 * from the scope element. Results come in composed tree order, a shadow
 * root's elements before its host's light children. A selector the page
 * cannot parse is its error message. Runs in the page, in `SELECTOR_SANDBOX`.
 */
function selectChain(parts: readonly PagePart[]): { element: Element; localName: string }[] | string {
  const composedParent = (element: Element): Element | null =>
    element.parentElement ?? (element.parentNode !== null && element.parentNode.nodeType === 11 ? (element.parentNode as ShadowRoot).host : null);
  let batches = 0;
  const queryCss = (scope: Document | Element, chains: readonly (readonly CssStep[])[], into: Set<Element>): void => {
    const roots: (Document | Element | ShadowRoot)[] = [];
    const collect = (root: Document | Element | ShadowRoot): void => {
      roots.push(root);
      if (root.nodeType === 1 && (root as Element).shadowRoot !== null) collect((root as Element).shadowRoot!);
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) collect(element.shadowRoot);
    };
    collect(scope);
    const isScope = (element: Element): boolean => (scope.nodeType === 9 ? element === (scope as Document).documentElement : element === scope);
    const matchesCompound = (element: Element, compound: string): boolean => (compound.includes(':scope') ? isScope(element) : element !== scope) && element.matches(compound);
    const parentOf = (element: Element): Element | null => (element === scope ? null : composedParent(element));
    const previousOf = (element: Element): Element | null => (element === scope ? null : element.previousElementSibling);
    for (const chain of chains) {
      const memo = new Map<Element, (boolean | undefined)[]>();
      const matchesBefore = (element: Element, index: number): boolean => {
        if (index === 0) return true;
        const known = memo.get(element)?.[index];
        if (known !== undefined) return known;
        const { combinator } = chain[index]!;
        const before = chain[index - 1]!;
        let result = false;
        if (combinator === '>' || combinator === '+') {
          const next = combinator === '>' ? parentOf(element) : previousOf(element);
          result = next !== null && matchesCompound(next, before.compound) && matchesBefore(next, index - 1);
        } else {
          const step = combinator === '~' ? previousOf : parentOf;
          for (let at = step(element); at !== null; at = step(at)) {
            if (!matchesCompound(at, before.compound)) continue;
            if (matchesBefore(at, index - 1)) {
              result = true;
              break;
            }
            if (before.combinator === combinator) break;
          }
        }
        const entry = memo.get(element) ?? [];
        entry[index] = result;
        memo.set(element, entry);
        return result;
      };
      const last = chain[chain.length - 1]!;
      for (const root of roots) {
        const size = into.size;
        for (const element of root.querySelectorAll(last.compound)) if (matchesBefore(element, chain.length - 1)) into.add(element);
        if (into.size > size) batches += 1;
      }
    }
  };
  const queryXpath = (scope: Document | Element, body: string, into: Set<Element>): void => {
    const expression = scope.nodeType !== 9 && body.startsWith('/') ? `.${body}` : body;
    const found = (scope.ownerDocument ?? (scope as Document)).evaluate(expression, scope, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);
    const size = into.size;
    for (let node = found.iterateNext(); node !== null; node = found.iterateNext()) if (node.nodeType === 1) into.add(node as Element);
    if (into.size > size) batches += 1;
  };
  const composedPath = (element: Element): Element[] => {
    const path: Element[] = [];
    for (let at: Element | null = element; at !== null; at = composedParent(at)) path.push(at);
    return path.toReversed();
  };
  const compare = (a: readonly Element[], b: readonly Element[]): number => {
    let index = 0;
    while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
    if (index === a.length || index === b.length) return a.length - b.length;
    const x = a[index]!;
    const y = b[index]!;
    if (x.parentNode === y.parentNode) return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    return x.parentNode !== null && x.parentNode.nodeType === 11 ? -1 : 1;
  };
  try {
    let matched: (Document | Element)[] = [document];
    for (const part of parts) {
      if (part.engine === 'css') document.querySelector(part.body);
      const found = new Set<Element>();
      batches = 0;
      for (const scope of matched) {
        if (part.engine === 'css') queryCss(scope, part.chains, found);
        else queryXpath(scope, part.body, found);
      }
      matched = [...found];
    }
    if (batches <= 1) return (matched as Element[]).map((element) => ({ element, localName: element.localName }));
    const paths = new Map((matched as Element[]).map((element) => [element, composedPath(element)]));
    return [...paths.keys()].toSorted((a, b) => compare(paths.get(a)!, paths.get(b)!)).map((element) => ({ element, localName: element.localName }));
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * The elements `selector` matches in `context`'s document, in one round trip
 * (`selectChain`): CSS across open shadow roots and XPath in the light DOM,
 * as Playwright reads them.
 */
export async function selectElements(connection: BidiConnection, context: string, selector: string): Promise<SelectedElement[]> {
  const found = await callFunction(connection, context, selectChain, [pageParts(selector)], { maxObjectDepth: null, sandbox: SELECTOR_SANDBOX });
  if (typeof found === 'string') throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${found}`);
  if (!isSelection(found)) throw new EngineError('ENGINE_FAILURE', `selector ${selector} read an unexpected value`, { retryable: false });
  return found;
}

/** True for what `selectChain` returns once its elements crossed the wire. */
function isSelection(value: unknown): value is SelectedElement[] {
  return Array.isArray(value) && value.every((each: unknown) =>
    typeof each === 'object' && each !== null && Reflect.get(each, 'element') instanceof ElementRef && typeof Reflect.get(each, 'localName') === 'string');
}

/** The iframe that holds each child context the surface entered, by child context. */
export class FrameRegistry {
  private readonly holders = new Map<string, NodeTarget>();

  /** Records that `child` is the document of `frame`. */
  enter(child: string, frame: NodeTarget): void {
    this.holders.set(child, frame);
  }

  /** The iframes from the top-level document down to `context`, outermost first; empty for the top level. */
  chain(context: string): NodeTarget[] {
    const chain: NodeTarget[] = [];
    for (let holder = this.holders.get(context); holder !== undefined; holder = this.holders.get(holder.context)) {
      chain.unshift(holder);
    }
    return chain;
  }

  /**
   * Each iframe holding `context`, outermost first, as its document lays it
   * out (`FrameStep`). Null when a frame on the way lays out no box or is
   * rotated.
   */
  private async frameSteps(connection: BidiConnection, context: string): Promise<FrameStep[] | null> {
    const boxes = await measureFrames(connection, this.chain(context));
    return boxes !== null && boxes.every((box) => box !== TURNED) ? boxes : null;
  }

  /**
   * Each iframe holding `context`, outermost first, as the map from the
   * viewport of the document it shows to the viewport of its own document.
   * A frame turned by a rotation or a 3D transform maps through the quad
   * the browser lays its border box out on (`turnedFrameMap`). Null when a
   * frame on the way lays out no box, or the browser reports no quad for a
   * turned one.
   */
  async frameMaps(connection: BidiConnection, context: string, browser: BidiBrowserName): Promise<Projection[] | null> {
    const chain = this.chain(context);
    const boxes = await measureFrames(connection, chain);
    if (boxes === null) return null;
    const sessions = browser === 'chromium' && boxes.includes(TURNED) ? await Promise.all(chain.map((frame) => ChromiumCdp.forContext(connection, frame.context))) : undefined;
    const maps: Projection[] = [];
    let root: Projection = IDENTITY;
    for (const [index, box] of boxes.entries()) {
      if (index > 0) root = sessions !== undefined && sessions[index]!.session !== sessions[index - 1]!.session ? IDENTITY : compose(root, maps[index - 1]!);
      const map = box === TURNED ? await turnedFrameMap(connection, chain[index]!, sessions?.[index], root) : scaleThenTranslate(box.content, box.scale);
      if (map === undefined) return null;
      maps.push(map);
    }
    return maps;
  }

  /**
   * Where `context`'s viewport sits in the top-level one (`FrameView`).
   * Undefined for the top level, null when a frame on the way lays out no
   * box, is rotated, or shows none of it.
   */
  async viewportBox(connection: BidiConnection, context: string): Promise<FrameView | null | undefined> {
    const steps = await this.frameSteps(connection, context);
    if (steps === null) return null;
    let view: FrameView | undefined;
    for (const { content, scale } of steps) {
      if (view === undefined) {
        view = { origin: { x: content.x, y: content.y }, scale, clip: content };
        continue;
      }
      const placed = toParent(content, view);
      const clip = clipTo(placed, view.clip);
      if (clip === undefined) return null;
      view = { origin: { x: placed.x, y: placed.y }, scale: { x: view.scale.x * scale.x, y: view.scale.y * scale.y }, clip };
    }
    return view;
  }

  /** Forgets every frame, when the documents that held them are gone. */
  clear(): void {
    this.holders.clear();
  }
}

/** What `FRAME_BOX` reports for a frame a rotation, skew, reflection, or 3D transform turns. */
const TURNED = 'turned';

/** The corners of a quad, top-left first and clockwise. */
type Quad = readonly [Point, Point, Point, Point];

/** A frame element's border box size and content inset, and, where the page has `getBoxQuads` (Firefox), the quad its border box lays out on in its document's viewport. */
interface FrameBorderBox {
  readonly width: number;
  readonly height: number;
  readonly inset: Rect;
  readonly quad: readonly Point[] | null;
}

/** Measures a frame element's `FrameBorderBox`. Runs in the page. */
const FRAME_BORDER_BOX = `(element) => {
  const [quad] = typeof element.getBoxQuads === 'function' ? element.getBoxQuads({ box: 'border', relativeTo: element.ownerDocument }) : [];
  return {
    width: element.offsetWidth,
    height: element.offsetHeight,
    inset: (${frameContentInset.toString()})(element),
    quad: quad === undefined ? null : [quad.p1, quad.p2, quad.p3, quad.p4].map(({ x, y }) => ({ x, y })),
  };
}`;

/**
 * The map from the viewport of the document a turned frame shows to the
 * viewport of the frame's own document: its content inset, then the quad
 * its border box lays out on. Chromium reports the quad (CDP
 * `DOM.getContentQuads`) in the viewport of the frame's local root, the
 * outermost document its process renders, which `root` maps the frame's
 * document into, for the node chromium-bidi's shared id ends in
 * (`f.<frame>.d.<document>.e.<backend node id>`); Firefox reports it in the
 * frame's document (`getBoxQuads`, behind `layout.css.getBoxQuads.enabled`).
 * Undefined when the browser reports none.
 */
async function turnedFrameMap(connection: BidiConnection, frame: NodeTarget, cdp: ChromiumCdp | undefined, root: Projection): Promise<Projection | undefined> {
  const box = await callFunction(connection, frame.context, FRAME_BORDER_BOX, [frame.element], { maxObjectDepth: null });
  if (!isFrameBorderBox(box)) return undefined;
  let quad = box.quad === null ? null : quadOf(box.quad);
  let toDocument: Projection | undefined = IDENTITY;
  if (cdp !== undefined) {
    const backendNodeId = Number(/\.e\.(\d+)$/.exec(frame.element.sharedId)?.[1]);
    if (!Number.isInteger(backendNodeId)) return undefined;
    const [flat] = (await cdp.send('DOM.getContentQuads', { backendNodeId })).quads;
    quad = flat === undefined ? null : quadOf([0, 2, 4, 6].map((at) => ({ x: flat[at]!, y: flat[at + 1]! })));
    toDocument = invert(root);
  }
  if (quad === null || toDocument === undefined) return undefined;
  const border = rectToQuad(box.width, box.height, quad);
  if (border === undefined) return undefined;
  return compose(toDocument, compose(border, scaleThenTranslate(box.inset, { x: 1, y: 1 })));
}

/** The quad whose corners `points` lists, top-left first and clockwise; null unless there are four. */
function quadOf(points: readonly Point[]): Quad | null {
  const [p0, p1, p2, p3] = points;
  return points.length === 4 && p0 !== undefined && p1 !== undefined && p2 !== undefined && p3 !== undefined ? [p0, p1, p2, p3] : null;
}

/** True for what `FRAME_BORDER_BOX` reports. */
function isFrameBorderBox(value: unknown): value is FrameBorderBox {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'width') === 'number' && typeof Reflect.get(value, 'height') === 'number'
    && typeof Reflect.get(value, 'inset') === 'object' && (Reflect.get(value, 'quad') === null || Array.isArray(Reflect.get(value, 'quad')));
}

/** True for what `FRAME_BOX` reports for a frame with a box. */
function isFrameBox(value: unknown): value is FrameStep {
  return typeof value === 'object' && value !== null && 'content' in value && 'scale' in value;
}

/** Each frame of `chain` measured by `FRAME_BOX`, the documents read at once; null when one lays out no box. */
async function measureFrames(connection: BidiConnection, chain: readonly NodeTarget[]): Promise<(FrameStep | typeof TURNED)[] | null> {
  const boxes = await Promise.all(chain.map((frame) => callFunction(connection, frame.context, FRAME_BOX, [frame.element, CLOSED_SHADOW_ROOTS_KEY])));
  const steps: (FrameStep | typeof TURNED)[] = [];
  for (const box of boxes) {
    if (box !== TURNED && !isFrameBox(box)) return null;
    steps.push(box);
  }
  return steps;
}

/**
 * An iframe's content box in its own document's viewport, and the scale its
 * transforms (its own and its ancestors') apply to the document inside it;
 * null for a frame that lays out no box, and `TURNED` for one a rotation,
 * skew, reflection, or 3D transform (its own or a composed ancestor's,
 * through slots and recorded closed roots; `transform` or the `rotate` and
 * `scale` properties) turns, whose points no scale maps.
 */
const FRAME_BOX = `(element, key) => {
  if (element.getClientRects().length === 0) return null;
  const recorded = Reflect.get(globalThis, Symbol.for(key));
  const parentOf = (at) => {
    if (at.assignedSlot !== null) return at.assignedSlot;
    const closed = at.parentElement === null ? undefined : recorded?.get(at.parentElement);
    for (const slot of closed?.querySelectorAll('slot') ?? []) if (slot.assignedElements({ flatten: true }).includes(at)) return slot;
    return at.parentElement ?? (at.getRootNode() instanceof ShadowRoot ? at.getRootNode().host : null);
  };
  for (let at = element; at !== null; at = parentOf(at)) {
    const style = getComputedStyle(at);
    if (style.rotate !== 'none' || style.scale.includes('-')) return '${TURNED}';
    if (style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return '${TURNED}';
    }
  }
  const inset = (${frameContentInset.toString()})(element);
  const rect = element.getBoundingClientRect();
  const scale = { x: element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1, y: element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1 };
  return {
    content: { x: rect.x + inset.x * scale.x, y: rect.y + inset.y * scale.y, width: inset.width * scale.x, height: inset.height * scale.y },
    scale,
  };
}`;

/**
 * The browsing context the innermost frame of `selectors` shows, each
 * selector matched in the document of the one before it: `FRAME_NOT_FOUND`
 * (retryable, a frame loads) when one matches nothing or has no document
 * yet, `FRAME_AMBIGUOUS` when one matches more than one iframe. Every frame
 * on the way is recorded in `frames`.
 */
export async function resolveFrames(
  connection: BidiConnection,
  top: string,
  selectors: readonly string[],
  frames: FrameRegistry,
): Promise<string> {
  let context = top;
  for (const selector of selectors) {
    const found = await callFunction(connection, context, SELECT_FRAME, [pageParts(selector)], { maxObjectDepth: null, sandbox: SELECTOR_SANDBOX });
    if (typeof found === 'string') throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${found}`);
    const count = typeof found === 'object' && found !== null ? Reflect.get(found, 'count') : undefined;
    if (typeof count !== 'number') throw new EngineError('ENGINE_FAILURE', `frame selector ${selector} read an unexpected value`, { retryable: false });
    if (count === 0) throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, { retryable: true });
    if (count > 1) throw new EngineError('FRAME_AMBIGUOUS', `${count} frames match ${selector}`, { retryable: false });
    const element: unknown = Reflect.get(found as object, 'element');
    const window: unknown = Reflect.get(found as object, 'window');
    if (!(element instanceof ElementRef)) throw new EngineError('ENGINE_FAILURE', `frame selector ${selector} read an unexpected value`, { retryable: false });
    if (!(window instanceof WindowRef)) throw new EngineError('FRAME_NOT_FOUND', `frame ${selector} has no document yet`, { retryable: true });
    frames.enter(window.context, { element, context });
    context = window.context;
  }
  return context;
}

/**
 * The iframe or frame elements a chain (`pageParts`) matches, in one call:
 * how many, and for exactly one, the element and its window. Runs in the
 * page.
 */
const SELECT_FRAME = `(parts) => {
  const found = (${selectChain.toString()})(parts);
  if (typeof found === 'string') return found;
  const frames = found.filter(({ localName }) => localName === 'iframe' || localName === 'frame');
  const only = frames.length === 1 ? frames[0].element : null;
  return { count: frames.length, element: only, window: only === null ? null : only.contentWindow };
}`;

/**
 * A locator expression split at its frames in one walk: the selectors of the
 * frames it descends through, outermost first, and the expression the
 * innermost frame's document answers, its `frame` steps removed. A union
 * whose branches, or a `has` or `hasNot` whose locator, names another frame
 * chain than its source is `UNSUPPORTED_CAPABILITY`.
 */
export function splitFrames(expression: LocatorExpression): { chain: string[]; inner: LocatorExpression } {
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((selector, index) => selector === b[index]);
  switch (expression.kind) {
    case 'frame': {
      const { chain, inner } = splitFrames(expression.source);
      return { chain: [expression.selector, ...chain], inner };
    }
    case 'query': {
      if (expression.scope === undefined) return { chain: [], inner: expression };
      const { chain, inner } = splitFrames(expression.scope);
      return { chain, inner: { ...expression, scope: inner } };
    }
    case 'filter': {
      const source = splitFrames(expression.source);
      const inners: { has?: LocatorExpression; hasNot?: LocatorExpression } = {};
      for (const key of ['has', 'hasNot'] as const) {
        const filter = expression[key];
        if (filter === undefined) continue;
        const { chain, inner } = splitFrames(filter);
        if (chain.length > 0 && !same(chain, source.chain)) {
          throw new EngineError('UNSUPPORTED_CAPABILITY', 'an inner has or hasNot locator must belong to the same frame as the locator it filters', { retryable: false });
        }
        inners[key] = inner;
      }
      return { chain: source.chain, inner: { ...expression, source: source.inner, ...inners } };
    }
    case 'index': {
      const { chain, inner } = splitFrames(expression.source);
      return { chain, inner: { ...expression, source: inner } };
    }
    case 'union': {
      const left = splitFrames(expression.left);
      const right = splitFrames(expression.right);
      if (!same(left.chain, right.chain)) {
        throw new EngineError('UNSUPPORTED_CAPABILITY', 'locator.or requires both branches in the same document', { retryable: false });
      }
      return { chain: left.chain, inner: { ...expression, left: left.inner, right: right.inner } };
    }
    case 'selector':
      return { chain: [], inner: expression };
  }
}

/**
 * A node read inside a frame, in the top-level viewport: its box shifted by
 * the frame's origin and scale and clipped to what the frame shows, dropped when the
 * frame has no box or the node lies outside it, and its frame path set.
 */
export function inViewport(node: SemanticNode, frame: FrameView | null | undefined, framePath: readonly string[]): SemanticNode {
  const withPath = framePath.length === 0 ? node : { ...node, framePath };
  if (frame === undefined || node.rect === undefined) return withPath;
  const { rect: _rect, ...rest } = withPath;
  const placed = frame === null ? undefined : clipTo(toParent(node.rect, frame), frame.clip);
  return placed === undefined ? rest : { ...rest, rect: placed };
}
