/**
 * Observation and location on the BiDi driver: the semantic tree with its
 * on-site frames stitched in, masked pixels, and locator resolution with
 * the contract's reference semantics.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  EngineError,
  matchesText,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  resolveExpression,
  type EngineObserveOptions,
  type EngineSnapshot,
  type LocatorExpression,
  type ObservationPixels,
  type SemanticNode,
  type SemanticQuery,
  type TextPattern,
  type ViewportSize,
  withTimeout,
} from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_KEY } from '../closed-shadow.ts';
import { assembleTree, frameContentInset, isOnSiteFrame, ROOT_NODE_ID, toSemanticNode } from '../observation.ts';
import { readPngSize } from '../observe.ts';
import { SECURE_FIELD_SELECTOR, type RawNodeData } from '../read-node.ts';
import { cancelled } from '../support.ts';
import { isStale, releaseQuietly, unlessStale } from './errors.ts';
import { contentContext, inViewport, resolveFrames, selectElements, splitFrames, type NodeTarget } from './frames.ts';
import { domReady, maskSecureFields, unmaskSecureFields } from './page.ts';
import type { EncodedReaderArgs, LocateWants, PlaywrightAria, WantedQuery } from './readers.ts';
import { ElementRef } from './script.ts';
import type { BidiSession } from './session.ts';

/** Shared node budget of one observation. */
const MAX_OBSERVED_NODES = 3_000;
/** Nested iframe capture depth; deeper frames stay boundary nodes. */
const MAX_FRAME_DEPTH = 4;
/** Settling is best-effort and spends from the observation's budget. */
const SETTLE_TIMEOUT_MS = 5_000;

type Rect = NonNullable<SemanticNode['rect']>;

/** One read document's tree with the element behind each of its ids. */
interface CapturedTree {
  readonly tree: SemanticNode;
  readonly generation: Map<string, NodeTarget>;
  readonly nodeCount: number;
  readonly truncated: boolean;
}

/** Time a `pixelFallback` observation keeps for fresh masked pixels once the semantic read runs out; at most a quarter of what is left. */
const PIXEL_FALLBACK_RESERVE_MS = 2_000;

/**
 * One semantic observation, with masked pixels when asked, taken after the
 * tree so no screenshot mask is ever read into it. Pixels a capture could
 * not produce are left out, as the contract allows; the tree is never. With
 * `pixelFallback`, a semantic read that outlives its share of the budget is
 * abandoned for fresh masked pixels under the stable root alone
 * (`treeUnavailable`), and every ref is retired; the ids the abandoned read
 * was given stay reserved, so none is minted again.
 */
export async function observe(session: BidiSession, timeoutMs: number, signal: AbortSignal, options?: EngineObserveOptions): Promise<EngineSnapshot> {
  const context = session.requireContext();
  const deadline = Date.now() + timeoutMs;
  await unlessStale(session.run(domReady, [Math.min(SETTLE_TIMEOUT_MS, timeoutMs / 2)]), undefined);
  const viewport = await session.viewportSize();
  if (options?.pixelFallback !== true) return observeTree(session, context, viewport, deadline, signal, options);
  const semanticDeadline = deadline - Math.min(PIXEL_FALLBACK_RESERVE_MS, (deadline - Date.now()) / 4);
  const abandoned = new AbortController();
  const read = observeTree(session, context, viewport, semanticDeadline, AbortSignal.any([signal, abandoned.signal]), options);
  const timedOut = new EngineError('OPERATION_TIMEOUT', 'the semantic read timed out', { retryable: false });
  try {
    return await withTimeout(read, Math.max(0, semanticDeadline - Date.now()), () => timedOut);
  } catch (cause) {
    if (cause !== timedOut || signal.aborted) throw cause;
    abandoned.abort();
    read.catch(() => undefined);
    session.refs.clear();
    const remaining = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
    const fallbackViewport = await session.viewportSize();
    const pixels = await maskedPixels(session, fallbackViewport, remaining).catch(() => {
      throw cause;
    });
    return {
      location: await session.currentUrl(),
      root: { ref: { id: ROOT_NODE_ID, revision: '' } },
      viewport: fallbackViewport,
      truncated: true,
      treeUnavailable: true,
      pixels: pixels.pixels,
      maskedRegionCount: pixels.maskedRegionCount,
    };
  }
}

/** The tree read by `deadline` and the masked pixels after it when asked, published unless `signal` ended the read first. */
async function observeTree(
  session: BidiSession,
  context: string,
  viewport: ViewportSize,
  deadline: number,
  signal: AbortSignal,
  options: EngineObserveOptions | undefined,
): Promise<EngineSnapshot> {
  const captured = await captureTree(session, context, [], MAX_OBSERVED_NODES, deadline);
  if (signal.aborted) throw cancelled('observe cancelled');
  const pixels = options?.pixels === true ? await maskedPixels(session, viewport, signal).then((value) => value, () => undefined) : undefined;
  if (signal.aborted) throw cancelled('observe cancelled');
  session.refs.publish(captured.generation);
  return {
    location: await session.currentUrl(),
    root: captured.tree,
    viewport,
    ...(captured.truncated ? { truncated: true } : {}),
    ...(pixels === undefined ? {} : { pixels: pixels.pixels, maskedRegionCount: pixels.maskedRegionCount }),
  };
}

/** How long the screen an action left may take for the trace before the step goes without one. */
const TRACE_SCREEN_TIMEOUT_MS = 1_000;

/**
 * Hands the trace the screen an action left, when the attempt keeps one. The
 * screen is read like an observation but never published, so every ref a
 * test or model holds stays valid. The `screen` contract has the engine give
 * up silently on a page that cannot answer within a second: the action
 * already succeeded, and a trace screen never fails it.
 */
export async function traceScreen(session: BidiSession, signal: AbortSignal): Promise<void> {
  const sink = session.attempt.screen;
  if (sink === undefined || signal.aborted || session.context === undefined) return;
  const context = session.context;
  const read = async (): Promise<EngineSnapshot> => {
    const captured = await captureTree(session, context, [], MAX_OBSERVED_NODES, Date.now() + TRACE_SCREEN_TIMEOUT_MS);
    return { location: await session.currentUrl(), root: captured.tree, viewport: await session.viewportSize(), ...(captured.truncated ? { truncated: true } : {}) };
  };
  try {
    sink(await withTimeout(read(), TRACE_SCREEN_TIMEOUT_MS, () => new Error('trace screen timed out')));
  } catch {
    return;
  }
}

/**
 * Resolves one expression with the contract's reference semantics
 * (`resolveExpression`) over node-mode reads of the elements its queries
 * could match, in the document its frame chain names; a `selector` is
 * answered by `browsingContext.locateNodes`; text, label, display-value,
 * and role queries and text filters follow Playwright's own engines
 * (`playwrightMatches`), so both drivers answer one locator alike.
 */
export async function locate(session: BidiSession, expression: LocatorExpression): Promise<SemanticNode[]> {
  const { chain, context, matches } = await resolveLocator(session, expression);
  const frameBox = chain.length === 0 ? undefined : await session.frames.viewportBox(session.connection, context);
  // A sole match keeps its expression, so a ref that turns ambiguous before an action is stale instead of acting on one of them.
  const locator = matches.length === 1 ? { locator: expression } : {};
  return matches.map(({ node, element }) => {
    session.refs.storeLocated(node.ref.id, { element, context, ...locator });
    const { children: _children, ...rest } = node;
    return inViewport(rest, frameBox, chain);
  });
}

/**
 * Fails as retryable `NODE_STALE` unless the expression that located
 * `target` as its only match still matches that element alone: a second
 * match, or none, means the ref no longer names one element. A target an
 * observation or a many-match locate gave passes as it is.
 */
export async function stillLocated(session: BidiSession, target: NodeTarget): Promise<void> {
  if (target.locator === undefined) return;
  const { matches } = await resolveLocator(session, target.locator);
  if (matches.length === 1 && matches[0]!.element.sharedId === target.element.sharedId) return;
  const now = matches.length === 0 ? 'nothing' : matches.length === 1 ? 'another element' : `${matches.length} elements`;
  throw new EngineError('NODE_STALE', `the located element is no longer its locator's only match: the locator now matches ${now}`, { retryable: true });
}

/** The nodes `expression` matches now, each with its element, and the document its frame chain leads to. */
async function resolveLocator(session: BidiSession, expression: LocatorExpression): Promise<{ chain: string[]; context: string; matches: { node: SemanticNode; element: ElementRef }[] }> {
  const { chain, inner } = splitFrames(expression);
  const context = await resolveFrames(session.connection, session.requireContext(), chain, session.frames);
  const selected = await locateSelectors(session, inner, context);
  const options = { testIdAttribute: session.settings.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR };
  const frameHidden = await insideHiddenFrame(session, context, options);
  const { metadata, elements } = await session.readEncoded('locate', (): EncodedReaderArgs<'locate'> => [options, wantedQueries(inner), CLOSED_SHADOW_ROOTS_KEY], context);
  const { nodes, parents, valued, aria, order } = metadata;
  if (!Array.isArray(nodes) || !Array.isArray(parents) || !Array.isArray(valued) || !Array.isArray(aria) || !Array.isArray(order) || [parents, valued, aria, order, elements].some((list) => list.length !== nodes.length)) {
    throw new EngineError('ENGINE_FAILURE', 'located reads do not align with their elements', { retryable: false });
  }
  if (frameHidden) {
    for (const [index, node] of nodes.entries()) {
      nodes[index] = { ...node, states: { ...node.states, hidden: true } };
      aria[index] = { ...aria[index]!, hidden: true };
    }
  }
  const first = session.refs.reserveIds(nodes.length);
  const ids = nodes.map((_node, index) => `n${first + index}`);
  const sharedIds = new Map(ids.map((id, index) => [id, elements[index]!.sharedId]));
  const reads = new Map(ids.map((id, index) => [id, { labels: nodes[index]!.labels ?? [], valued: valued[index]!, aria: aria[index]! }]));
  const ranks = new Map(ids.map((id, index) => [id, order[index]!]));
  const matches = resolveExpression(inner, buildForest(nodes, parents, ids), {
    matches: (node, query) => playwrightMatches(node, query, reads.get(node.ref.id)),
    hasText: (node, pattern) => matchesText(reads.get(node.ref.id)?.aria.text ?? '', pattern),
    order: (a, b) => (ranks.get(a.ref.id) ?? 0) - (ranks.get(b.ref.id) ?? 0),
    selector: (selector, candidates) => {
      const hits = selected.get(selector) ?? new Set<string>();
      return candidates.filter((node) => hits.has(sharedIds.get(node.ref.id) ?? ''));
    },
  });
  return { chain, context, matches: matches.map((node) => ({ node, element: new ElementRef(sharedIds.get(node.ref.id) ?? '') })) };
}

/**
 * Whether a frame along the chain to `context` is hidden: each frame element's
 * own `hidden` state, read in the document around it, so a cross-origin
 * frame reads too. Everything inside a hidden frame is hidden, and so are the
 * frames under it.
 */
async function insideHiddenFrame(session: BidiSession, context: string, options: { readonly testIdAttribute: string; readonly secureFieldSelector: string }): Promise<boolean> {
  for (const frame of session.frames.chain(context)) {
    if (await session.reader('hidden', [frame.element, options], frame.context)) return true;
  }
  return false;
}

/** What `playwrightMatches` reads of one located element. */
interface LocatedRead {
  readonly labels: readonly string[];
  readonly valued: boolean;
  readonly aria: PlaywrightAria;
}

/**
 * Whether `node` matches `query` by Playwright's engines, the Playwright
 * driver's semantics: a text query on the element's joined text, a label
 * query on any one of its labels, a display value on controls that display
 * one, and a role query that skips what is hidden from the accessibility
 * tree (not merely unrendered) and tells a `mixed` or absent state from
 * false. Other kinds keep the reference rules.
 */
function playwrightMatches(node: SemanticNode, query: SemanticQuery, read: LocatedRead | undefined): boolean | undefined {
  if (read === undefined) return undefined;
  switch (query.kind) {
    case 'text':
      return matchesText(read.aria.text, query.value);
    case 'label':
      return read.labels.some((label) => matchesText(label, query.value));
    case 'displayValue':
      return read.valued && node.value !== undefined && matchesText(node.value, query.value);
    case 'role': {
      if (query.value.kind !== 'string' || (node.role ?? '') !== query.value.value || read.aria.hidden) return false;
      if (query.name !== undefined && !matchesText(roleQueryName(node, read), query.name)) return false;
      const states = query.states ?? {};
      if (states.checked !== undefined && read.aria.checked !== states.checked) return false;
      if (states.pressed !== undefined && read.aria.pressed !== states.pressed) return false;
      if (states.expanded !== undefined && read.aria.expanded !== states.expanded) return false;
      if (states.selected !== undefined && read.aria.selected !== states.selected) return false;
      if (states.disabled !== undefined && (node.states?.disabled ?? false) !== states.disabled) return false;
      return query.level === undefined || node.level === query.level;
    }
    default:
      return undefined;
  }
}

/** Roles the tree names from their content so a row reads as one line, which Playwright's accessible name leaves unnamed. */
const TREE_CONTENT_NAMED = new Set(['listitem', 'status', 'alert']);

/**
 * The name a role query compares: the reader's, except the content name the
 * tree gives a role accname does not name from content (a name equal to the
 * element's own text, with no authored label), which Playwright leaves empty.
 */
function roleQueryName(node: SemanticNode, read: LocatedRead | undefined): string {
  const name = node.name ?? '';
  if (!TREE_CONTENT_NAMED.has(node.role ?? '') || read === undefined) return name;
  const authored = ['aria-label', 'aria-labelledby', 'title'].some((attribute) => (node.attributes?.[attribute] ?? '').trim() !== '');
  const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
  return !authored && squash(name) === squash(read.aria.text) ? '' : name;
}

/** The shared ids every `selector` in the expression matches in `context`, read before the elements so one pass answers them all. */
async function locateSelectors(session: BidiSession, expression: LocatorExpression, context: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const selector of selectorsOf(expression)) {
    const found = await selectElements(session.connection, context, selector);
    out.set(selector, new Set(found.map(({ element }) => element.sharedId)));
  }
  return out;
}

/** Every `selector` the expression names. */
function selectorsOf(expression: LocatorExpression): Set<string> {
  const selectors = new Set<string>();
  const walk = (node: LocatorExpression): void => {
    switch (node.kind) {
      case 'selector':
        selectors.add(node.selector);
        return;
      case 'query':
        if (node.scope !== undefined) walk(node.scope);
        return;
      case 'filter':
        walk(node.source);
        if (node.has !== undefined) walk(node.has);
        if (node.hasNot !== undefined) walk(node.hasNot);
        return;
      case 'index':
      case 'frame':
        walk(node.source);
        return;
      case 'union':
        walk(node.left);
        walk(node.right);
    }
  };
  walk(expression);
  return selectors;
}

/**
 * Reads one document's tree in one call (the reader's metadata as one JSON
 * string, each walked element as its shared id), then each iframe on the
 * app's site, stitched under its boundary node within the node budget and
 * the deadline. An on-site frame left unread marks the tree truncated; a
 * frame whose document went away mid-read shows nothing, which is not
 * truncation; an off-site one stays a boundary node by design.
 */
async function captureTree(session: BidiSession, context: string, framePath: readonly string[], budget: number, deadline: number): Promise<CapturedTree> {
  const { metadata: decoded, elements } = await session.readEncoded('tree', (): EncodedReaderArgs<'tree'> => [{
    testIdAttribute: session.settings.testIdAttribute,
    secureFieldSelector: SECURE_FIELD_SELECTOR,
    mode: { kind: 'tree', maxNodes: budget, idSeed: session.refs.reserveIds(budget), nameLimit: OBSERVED_NAME_LIMIT, textLimit: OBSERVED_TEXT_LIMIT },
  }], context);
  const { nodes, ids } = decoded;
  if (!Array.isArray(ids) || ids.length !== nodes.length || elements.length !== nodes.length) {
    throw new EngineError('ENGINE_FAILURE', 'observation ids do not align with its nodes', { retryable: false });
  }
  if (nodes.length === 0) throw new EngineError('NODE_STALE', 'observation produced no nodes', { retryable: true });
  if (framePath.length === 0) ids[0] = ROOT_NODE_ID;
  const generation = new Map<string, NodeTarget>();
  elements.forEach((element, index) => generation.set(ids[index] as string, { element, context }));
  let nodeCount = nodes.length;
  let truncated = decoded.truncated;
  const frameChildren = new Map<number, { tree: SemanticNode; inset: Rect }>();
  for (let index = 0; index < nodes.length; index += 1) {
    const selector = nodes[index]!.frameSelector;
    if (selector === undefined) continue;
    const frame: NodeTarget = { element: elements[index]!, context };
    const child = await unlessStale(contentContext(session.connection, frame), undefined);
    if (child === undefined) continue;
    const tree = await unlessStale(session.connection.send('browsingContext.getTree', { root: child, maxDepth: 0 }), undefined);
    if (tree === undefined || !isOnSiteFrame(tree.contexts[0]?.url ?? '', session.settings.site)) continue;
    const remaining = budget - nodeCount;
    if (framePath.length >= MAX_FRAME_DEPTH || remaining <= 0 || Date.now() >= deadline || nodes[index]!.rect === null) {
      truncated = true;
      continue;
    }
    session.frames.enter(child, frame);
    const read = await unlessStale(readFrame(session, frame, child, [...framePath, selector], remaining, deadline), undefined);
    if (read === undefined) continue;
    for (const [id, target] of read.captured.generation) generation.set(id, target);
    frameChildren.set(index, { tree: read.captured.tree, inset: read.inset });
    nodeCount += read.captured.nodeCount;
    truncated ||= read.captured.truncated;
  }
  return { tree: assembleTree(nodes, ids, framePath, frameChildren), generation, nodeCount, truncated };
}

/** One child document's tree, and where its viewport sits inside the iframe's border box. */
async function readFrame(
  session: BidiSession,
  frame: NodeTarget,
  child: string,
  framePath: readonly string[],
  budget: number,
  deadline: number,
): Promise<{ inset: Rect; captured: CapturedTree }> {
  const inset = await session.run(frameContentInset, [frame.element], frame.context);
  return { inset, captured: await captureTree(session, child, framePath, budget, deadline) };
}

/**
 * A viewport screenshot with every secure field in every document covered
 * and the caret hidden. The capture fails open nowhere: a document that
 * cannot be masked, a frame that appeared or went away, or a field that
 * moved while the screenshot was taken fails it as `NODE_STALE`, retried on
 * a settled page, and any other masking failure fails it outright.
 */
export async function maskedPixels(session: BidiSession, viewport: ViewportSize, signal: AbortSignal): Promise<{ pixels: ObservationPixels; maskedRegionCount: number }> {
  for (;;) {
    try {
      return await maskedCapture(session, viewport);
    } catch (cause) {
      if (!isStale(cause) && !(cause instanceof EngineError && cause.code === 'NODE_STALE')) throw cause;
      if (signal.aborted) throw cause;
      await sleep(RECAPTURE_MS, undefined, { signal });
    }
  }
}

/** Pause before a capture the page's navigation spoiled is taken again. */
const RECAPTURE_MS = 50;

/** One masked capture; stale when a document went away under the masks. */
async function maskedCapture(session: BidiSession, viewport: ViewportSize): Promise<{ pixels: ObservationPixels; maskedRegionCount: number }> {
  const context = session.requireContext();
  const documents = await session.documentContexts(context);
  const masked: string[] = [];
  const token = randomUUID();
  let held = true;
  try {
    let count = 0;
    for (const each of documents) {
      count += await session.run(maskSecureFields, [SECURE_FIELD_SELECTOR, CLOSED_SHADOW_ROOTS_KEY, token], each);
      masked.push(each);
    }
    const { data } = await captureUnlessNavigated(session, context, documents);
    held = (await Promise.all(masked.map((each) => session.run(unmaskSecureFields, [token], each)))).every(Boolean);
    masked.length = 0;
    const after = await session.documentContexts(context);
    if (!held || after.length !== documents.length || after.some((each, index) => each !== documents[index])) {
      throw new EngineError('NODE_STALE', 'the page changed while its screenshot was masked', { retryable: true });
    }
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    const size = readPngSize(bytes) ?? viewport;
    return {
      pixels: { data: bytes, mediaType: 'image/png', width: size.width, height: size.height, scale: viewport.width > 0 ? size.width / viewport.width : 1 },
      maskedRegionCount: count,
    };
  } finally {
    await Promise.all(masked.map((each) => releaseQuietly(session.run(unmaskSecureFields, [token], each))));
  }
}

/**
 * Captures the tab's viewport, abandoning the capture as stale the moment a
 * document of `documents` starts navigating: the masks were drawn in the
 * document it replaces, so its pixels could show a field unmasked, and
 * Chromium may never answer a capture whose frame navigated under it.
 */
async function captureUnlessNavigated(session: BidiSession, context: string, documents: readonly string[]): Promise<{ data: string }> {
  const watched = new Set(documents);
  let off: () => void = () => undefined;
  const navigated = new Promise<never>((_resolve, reject) => {
    off = session.connection.on('browsingContext.navigationStarted', (event) => {
      if (watched.has(event.context)) reject(new EngineError('NODE_STALE', 'the page navigated while its screenshot was taken', { retryable: true }));
    });
  });
  const capture = session.connection.send('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/png' } });
  try {
    return await Promise.race([capture, navigated]);
  } finally {
    off();
    capture.catch(() => undefined);
    navigated.catch(() => undefined);
  }
}

/** A text pattern as a page function argument. */
function patternArgument(pattern: TextPattern): TextPattern {
  return pattern.kind === 'string'
    ? { kind: 'string', value: pattern.value, exact: pattern.exact }
    : { kind: 'regexp', source: pattern.source, flags: pattern.flags };
}

/**
 * What a locate must read, as the locate reader takes it: each query of the
 * expression, and whether a text filter needs every element with text. A
 * selector, or a role query whose role is a pattern, reads every element.
 */
export function wantedQueries(expression: LocatorExpression): LocateWants {
  const queries: WantedQuery[] = [];
  let hasText = false;
  let all = false;
  const walk = (node: LocatorExpression): void => {
    switch (node.kind) {
      case 'query': {
        const { kind, value, name } = node.query;
        if (kind === 'role' && value.kind !== 'string') all = true;
        queries.push({
          kind,
          value: patternArgument(value),
          ...(name === undefined ? {} : { name: patternArgument(name) }),
          ...(kind === 'role' && value.kind === 'string' ? { role: value.value } : {}),
        });
        if (node.scope !== undefined) walk(node.scope);
        return;
      }
      case 'selector':
        all = true;
        return;
      case 'filter':
        if (node.hasText !== undefined || node.hasNotText !== undefined) hasText = true;
        walk(node.source);
        if (node.has !== undefined) walk(node.has);
        if (node.hasNot !== undefined) walk(node.hasNot);
        return;
      case 'index':
      case 'frame':
        walk(node.source);
        return;
      case 'union':
        walk(node.left);
        walk(node.right);
    }
  };
  walk(expression);
  return { queries, hasText, all };
}

/** Builds the read elements into trees by their nearest read ancestor; the roots, in document order. */
export function buildForest(nodes: readonly RawNodeData[], parents: readonly number[], ids: readonly string[]): SemanticNode[] {
  const children: SemanticNode[][] = nodes.map(() => []);
  const built: SemanticNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    built[index] = toSemanticNode({ id: ids[index]!, revision: '' }, labelled(nodes[index]!), children[index]!);
    const parent = parents[index]!;
    if (parent >= 0) children[parent]!.unshift(built[index]!);
  }
  return built.filter((_node, index) => parents[index]! < 0);
}

/**
 * A read whose name the reader left empty (a hidden element has none) named
 * by its first label or its `aria-label`, so a label query finds a hidden
 * control as Playwright's `getByLabel` does.
 */
function labelled(raw: RawNodeData): RawNodeData {
  if (raw.name !== null) return raw;
  const name = raw.labels?.[0] ?? raw.attributes['aria-label'];
  return name === undefined ? raw : { ...raw, name };
}
