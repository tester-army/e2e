/**
 * Nested documents on the BiDi driver. An iframe's document is its own
 * browsing context, reached through the iframe element's `contentWindow`;
 * the surface remembers, for each child context it entered, the iframe
 * element that holds it, so a box measured inside the child can be placed in
 * the top-level viewport the pointer and the screenshot share.
 */

import type { BrowsingContext } from 'webdriver-bidi-protocol';
import { EngineError, TestError, type LocatorExpression, type SemanticNode } from 'e2e/engine';
import { message } from '../support.ts';
import { CLOSED_SHADOW_ROOTS_KEY } from '../closed-shadow.ts';
import { frameContentInset } from '../observation.ts';
import { BidiError, type BidiConnection } from './connection.ts';
import { callFunction, ElementRef, WindowRef } from './script.ts';

/** An element and the browsing context whose document holds it. */
export interface NodeTarget {
  readonly element: ElementRef;
  readonly context: string;
}

type Rect = NonNullable<SemanticNode['rect']>;

type Point = { readonly x: number; readonly y: number };

/** One iframe as its document lays it out: its content box, and the scale from the document inside it to that box. */
export interface FrameStep {
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

/**
 * A selector as a `browsingContext.locateNodes` locator, read as Playwright
 * reads one: an `xpath=` or `css=` prefix names its engine, and an
 * unprefixed one is XPath when it starts with `/`, `..`, or a parenthesized
 * path such as `(//li)[2]`, else CSS.
 */
export function selectorLocator(selector: string): BrowsingContext.Locator {
  if (selector.startsWith('xpath=')) return { type: 'xpath', value: selector.slice('xpath='.length) };
  if (selector.startsWith('css=')) return { type: 'css', value: selector.slice('css='.length) };
  return /^\(*(\/|\.\.)/.test(selector) ? { type: 'xpath', value: selector } : { type: 'css', value: selector };
}

/** One element a selector matched, and its tag name. */
export interface SelectedElement {
  readonly element: ElementRef;
  readonly localName: string;
}

/**
 * The elements of `selector` in document order, through open shadow roots,
 * as Playwright's CSS engine reads it: each compound is matched with the
 * browser's own `matches`, and the combinators between compounds walk the
 * composed tree, so a shadow host is the parent of its shadow root's
 * children and `my-host .inner` reaches into it. A selector the page cannot
 * parse is `INVALID_LOCATOR`. Runs in the page.
 */
function cssSelectAll(selector: string, scopes?: Element[]): { element: Element; localName: string }[] | string {
  type Step = { compound: string; combinator: ' ' | '>' | '+' | '~' | null };
  const split = (text: string, at: (char: string) => boolean): { parts: string[]; separators: string[] } => {
    const parts: string[] = [];
    const separators: string[] = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]!;
      if (quote !== '') {
        if (char === '\\') current += char + (text[++index] ?? '');
        else {
          if (char === quote) quote = '';
          current += char;
        }
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '(' || char === '[') depth += 1;
      else if (char === ')' || char === ']') depth -= 1;
      else if (depth === 0 && at(char)) {
        parts.push(current);
        separators.push(char);
        current = '';
        continue;
      }
      current += char;
    }
    parts.push(current);
    return { parts, separators };
  };
  const steps = (complex: string): Step[] => {
    const { parts, separators } = split(complex.trim(), (char) => char === '>' || char === '+' || char === '~');
    const out: Step[] = [];
    parts.forEach((part, index) => {
      const compounds = split(part, (char) => /\s/.test(char)).parts.filter((compound) => compound !== '');
      compounds.forEach((compound, inner) => {
        out.push({ compound, combinator: inner > 0 ? ' ' : index > 0 ? (separators[index - 1] as '>' | '+' | '~') : null });
      });
    });
    return out;
  };
  const parentOf = (element: Element): Element | null =>
    element.parentElement ?? (element.parentNode !== null && element.parentNode.nodeType === 11 ? (element.parentNode as ShadowRoot).host : null);
  const matchesFrom = (element: Element, chain: Step[], index: number): boolean => {
    const step = chain[index]!;
    if (!element.matches(step.compound)) return false;
    if (index === 0) return true;
    switch (step.combinator) {
      case '>': {
        const parent = parentOf(element);
        return parent !== null && matchesFrom(parent, chain, index - 1);
      }
      case '+': {
        const previous = element.previousElementSibling;
        return previous !== null && matchesFrom(previous, chain, index - 1);
      }
      case '~':
        for (let previous = element.previousElementSibling; previous !== null; previous = previous.previousElementSibling) if (matchesFrom(previous, chain, index - 1)) return true;
        return false;
      default:
        for (let ancestor = parentOf(element); ancestor !== null; ancestor = parentOf(ancestor)) if (matchesFrom(ancestor, chain, index - 1)) return true;
        return false;
    }
  };
  try {
    document.querySelector(selector);
    const chains = split(selector, (char) => char === ',').parts.map(steps);
    const out: { element: Element; localName: string }[] = [];
    const seen = new Set<Element>();
    const visit = (root: Document | ShadowRoot | Element): void => {
      for (const element of root.querySelectorAll('*')) {
        if (!seen.has(element) && chains.some((chain) => matchesFrom(element, chain, chain.length - 1))) {
          seen.add(element);
          out.push({ element, localName: element.localName });
        }
        if (element.shadowRoot !== null) visit(element.shadowRoot);
      }
    };
    if (scopes === undefined) visit(document);
    else for (const scope of scopes) {
      visit(scope);
      if (scope.shadowRoot !== null) visit(scope.shadowRoot);
    }
    return out;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * The elements `selector` matches in `context`'s document (see
 * `selectorLocator`): CSS across open shadow roots, as Playwright reads it,
 * XPath through `browsingContext.locateNodes`, which stays in the light DOM
 * as Playwright's XPath does.
 */
export async function selectElements(connection: BidiConnection, context: string, selector: string): Promise<SelectedElement[]> {
  const parts = chainParts(selector);
  if (parts.slice(0, -1).some((part) => part.startsWith('*'))) {
    throw new TestError('INVALID_LOCATOR', 'a selector that captures with * (*css=article >> text=Hello) is not supported: use filter({ has }) instead');
  }
  let selected: SelectedElement[] | undefined;
  for (const part of parts) {
    selected = await selectWithin(connection, context, part.replace(/^\*/, ''), selected?.map((each) => each.element), selector);
  }
  return selected ?? [];
}

/**
 * The parts of a `>>` chain, each resolved inside the elements the one before
 * it matched; a `>>` inside quotes or brackets belongs to its part.
 */
function chainParts(selector: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]!;
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (depth === 0 && selector.startsWith('>>', index)) {
      parts.push(selector.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

/** The elements one chain part matches: in the document, or inside `scopes` (descendants, open shadow roots included). */
async function selectWithin(connection: BidiConnection, context: string, part: string, scopes: readonly ElementRef[] | undefined, selector: string): Promise<SelectedElement[]> {
  if (scopes !== undefined && scopes.length === 0) return [];
  const locator = selectorLocator(part);
  if (locator.type === 'css') {
    const found = await callFunction(connection, context, cssSelectAll, scopes === undefined ? [locator.value] : [locator.value, [...scopes]], { maxObjectDepth: null });
    if (typeof found === 'string') throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${found}`);
    if (!isSelection(found)) throw new EngineError('ENGINE_FAILURE', `selector ${selector} read an unexpected value`, { retryable: false });
    return found;
  }
  try {
    const { nodes } = await connection.send('browsingContext.locateNodes', {
      context,
      locator,
      ...(scopes === undefined ? {} : { startNodes: scopes.map((scope) => ({ sharedId: scope.sharedId })) as [{ sharedId: string }, ...{ sharedId: string }[]] }),
    });
    return nodes.flatMap((node) => (node.sharedId === undefined ? [] : [{ element: new ElementRef(node.sharedId), localName: node.value?.localName ?? '' }]));
  } catch (cause) {
    if (cause instanceof BidiError && cause.error === 'invalid selector') {
      throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${message(cause)}`);
    }
    throw cause;
  }
}

/** True for what `cssSelectAll` returns once its elements crossed the wire. */
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
  async frameSteps(connection: BidiConnection, context: string): Promise<FrameStep[] | null> {
    const steps: FrameStep[] = [];
    for (const frame of this.chain(context)) {
      const measured = await callFunction(connection, frame.context, FRAME_BOX, [frame.element, CLOSED_SHADOW_ROOTS_KEY]);
      if (!isFrameBox(measured)) return null;
      steps.push(measured);
    }
    return steps;
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

/** True for what `FRAME_BOX` reports for a frame with a box. */
function isFrameBox(value: unknown): value is FrameStep {
  return typeof value === 'object' && value !== null && 'content' in value && 'scale' in value;
}

/**
 * An iframe's content box in its own document's viewport, and the scale its
 * transforms (its own and its ancestors') apply to the document inside it;
 * null for a frame that lays out no box, or one a rotation, skew,
 * reflection, or 3D transform (its own or a composed ancestor's, through
 * slots and recorded closed roots; `transform` or the `rotate` and `scale`
 * properties) turns, whose points no scale maps.
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
    if (style.rotate !== 'none' || style.scale.includes('-')) return null;
    if (style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return null;
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
    const iframes = (await selectElements(connection, context, selector)).filter((found) => found.localName === 'iframe' || found.localName === 'frame');
    if (iframes.length === 0) {
      throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, { retryable: true });
    }
    if (iframes.length > 1) {
      throw new EngineError('FRAME_AMBIGUOUS', `${iframes.length} frames match ${selector}`, { retryable: false });
    }
    const frame: NodeTarget = { element: iframes[0]!.element, context };
    const child = await contentContext(connection, frame);
    if (child === undefined) throw new EngineError('FRAME_NOT_FOUND', `frame ${selector} has no document yet`, { retryable: true });
    frames.enter(child, frame);
    context = child;
  }
  return context;
}

/**
 * The expression a frame's document answers: the same expression with its
 * `frame` steps removed, since the caller already resolved the frame chain
 * they name (`frameSelectors` checks every branch names the same chain).
 */
export function withinFrame(expression: LocatorExpression): LocatorExpression {
  switch (expression.kind) {
    case 'frame':
      return withinFrame(expression.source);
    case 'query':
      return expression.scope === undefined ? expression : { ...expression, scope: withinFrame(expression.scope) };
    case 'filter':
      return {
        ...expression,
        source: withinFrame(expression.source),
        ...(expression.has === undefined ? {} : { has: withinFrame(expression.has) }),
        ...(expression.hasNot === undefined ? {} : { hasNot: withinFrame(expression.hasNot) }),
      };
    case 'index':
      return { ...expression, source: withinFrame(expression.source) };
    case 'union':
      return { ...expression, left: withinFrame(expression.left), right: withinFrame(expression.right) };
    case 'selector':
      return expression;
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
