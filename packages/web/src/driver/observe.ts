/**
 * Observation and location on the BiDi driver: the semantic tree with its
 * on-site frames stitched in, masked pixels, and locators resolved in the
 * page by the contract's locator rules.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  type EngineObserveOptions,
  type EngineSnapshot,
  type LocatorExpression,
  type ObservationPixels,
  type SemanticNode,
  type ViewportSize,
  withTimeout,
} from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_KEY } from '../in-page/closed-shadow.ts';
import { assembleTree, frameContentInset, isOnSiteFrame, ROOT_NODE_ID, toSemanticNode } from '../observation.ts';
import { readPngSize } from '../observe.ts';
import { SECURE_FIELD_SELECTOR } from '../in-page/read-node.ts';
import { cancelled } from '../support.ts';
import { isStale, releaseQuietly, unlessStale } from '../errors.ts';
import { contentContext, inViewport, resolveFrames, selectElements, splitFrames, type NodeTarget } from './frames.ts';
import { domReady, maskSecureFields, unmaskSecureFields } from '../in-page/page.ts';
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
 * Resolves one expression in the document its frame chain names, by the
 * contract's locator rules run in the page (the `locate` reader), which
 * match each element as Playwright's engines do; a `selector` is answered
 * by `browsingContext.locateNodes` first.
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
  const { metadata: nodes, elements } = await session.readEncoded('locate', [options, JSON.stringify(inner), selected, frameHidden, CLOSED_SHADOW_ROOTS_KEY], context);
  if (!Array.isArray(nodes) || nodes.length !== elements.length) {
    throw new EngineError('ENGINE_FAILURE', 'located reads do not align with their elements', { retryable: false });
  }
  const first = session.refs.reserveIds(nodes.length);
  return { chain, context, matches: nodes.map((raw, index) => ({ node: toSemanticNode({ id: `n${first + index}`, revision: '' }, raw), element: elements[index]! })) };
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

/** The elements every `selector` in the expression matches in `context`, read before the locate that answers the rest. */
async function locateSelectors(session: BidiSession, expression: LocatorExpression, context: string): Promise<[string, ElementRef[]][]> {
  const out: [string, ElementRef[]][] = [];
  for (const selector of selectorsOf(expression)) {
    const found = await selectElements(session.connection, context, selector);
    out.push([selector, found.map(({ element }) => element)]);
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
  const { metadata: decoded, elements } = await session.readEncoded('tree', [{
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
 * cannot be masked, a frame that appeared or went away, a field that moved
 * while the screenshot was taken, or a capture the browser failed because
 * its document was replaced under it fails it as `NODE_STALE`, retried on a
 * settled page, and any other failure fails it outright.
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
    // Firefox fails a capture whose document a navigation already under way replaced mid-snapshot
    // ("Unable to capture screenshot"), so a failed capture is stale when a masked document was replaced.
    const captured = await captureUnlessNavigated(session, context, documents).then((value) => value, (cause: unknown) => ({ failed: cause }));
    held = (await Promise.all(masked.map((each) => session.run(unmaskSecureFields, [token], each)))).every(Boolean);
    masked.length = 0;
    const after = await session.documentContexts(context);
    if (!held || after.length !== documents.length || after.some((each, index) => each !== documents[index])) {
      throw new EngineError('NODE_STALE', 'the page changed while its screenshot was masked', { retryable: true, cause: 'failed' in captured ? captured.failed : undefined });
    }
    if ('failed' in captured) throw captured.failed;
    const { data } = captured;
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
