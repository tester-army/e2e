/** Observation capture, redaction, and model serialization. */

import type { Observation, SemanticNode, ViewportSize } from '../engine/surface.ts';
import { collapseText } from '../internal/text.ts';
import { sleep } from '../internal/time.ts';
import type { VisionDegradation } from '../run/steps.ts';
import type { ExecutorNode, ExecutorObservation, ExecutorPixels } from './executor.ts';
import { sizeForModel } from './pixels.ts';
import { TestError } from '../internal/errors.ts';

/** Appended when the node walk stopped at the observation byte budget. */
const TRUNCATION_MARKER = '[observation truncated at the resolved observation byte limit]';
/** Appended when the engine reported its tree incomplete and the byte budget did not cut it further. */
const ENGINE_TRUNCATION_MARKER = '[observation truncated: the engine stopped listing nodes at its limit]';
/** Missing semantics are unknown, including on a surface that appears empty. */
const UNAVAILABLE_TREE_MARKER = '[semantic capture unavailable: no nodes were read; previous node ids are no longer valid. Use the screenshot, never infer absence from this listing]';

/** Why pixels the caller asked for are not part of this observation. */
type PixelsWithheld = 'MASKING_UNPROVEN';

export type AgentObservation = AgentObservationMetadata & (
  | {
      readonly kind: 'semantic';
      readonly nodes: ReadonlyMap<string, SemanticNode>;
      readonly parents: ReadonlyMap<string, string>;
      readonly tree: SemanticNode;
      readonly truncated: boolean;
      readonly pixels?: ExecutorPixels | undefined;
      readonly pixelsWithheld?: PixelsWithheld | undefined;
    }
  | {
      readonly kind: 'pixels';
      readonly pixels: ExecutorPixels;
    }
);

/** An observation whose node references can be resolved or described. */
export type SemanticAgentObservation = Extract<AgentObservation, { kind: 'semantic' }>;

/** Identity, geometry, and redacted prose shared by both evidence variants. */
interface AgentObservationMetadata {
  /** Where the surface was when captured, when the platform has a location. */
  readonly location?: string;
  /** Location projected to path and query when it is a URL, otherwise kept opaque. */
  readonly path?: string;
  readonly revision: string;
  /** Redacted, size-bounded serialization sent to the model. */
  readonly text: string;
  readonly bytes: number;
  readonly viewport: ViewportSize;
}

/**
 * Turns one raw engine observation into redacted model input.
 *
 * Pixels whose masking the engine cannot prove (fewer masked regions than
 * secure nodes) are withheld before they reach a model or disk; the semantic
 * tree never carries secure values. Registered secret values are additionally
 * replaced by their stable secret name.
 */
export function prepareObservation(
  observation: Observation,
  options: {
    redact: (text: string) => string;
    maxBytes: number;
    /** Grants pixel-only evidence; omit when this consumer cannot use it. */
    pixelsAllowed?: boolean;
  },
): AgentObservation {
  const location = observation.location === undefined ? undefined : options.redact(observation.location);
  const path = location === undefined ? undefined : observationPath(location);
  const metadata = {
    revision: observation.revision,
    ...(location === undefined ? {} : { location }),
    ...(path === undefined ? {} : { path }),
    viewport: observation.viewport,
  };
  const pixels = clearPixels(observation);
  if (observation.kind === 'pixels') {
    if (options.pixelsAllowed !== true || pixels.cleared === undefined) {
      throw new TestError('UNSUPPORTED_CAPABILITY', 'semantic capture is unavailable and no permitted, proven-masked screenshot can replace it');
    }
    return {
      ...metadata,
      kind: 'pixels',
      text: UNAVAILABLE_TREE_MARKER,
      bytes: new TextEncoder().encode(UNAVAILABLE_TREE_MARKER).byteLength,
      pixels: pixels.cleared,
    };
  }
  const nodes = new Map<string, SemanticNode>();
  const parents = new Map<string, string>();
  indexNodes(observation.tree, nodes, parents);

  const redact = options.redact;
  const lines: string[] = [];
  const encoder = new TextEncoder();
  // The marker is reserved up front so a truncated observation still fits the
  // budget; the budget is what keeps the request under the token ceiling.
  const markerFor = (cutByBudget: boolean): string | undefined => {
    if (cutByBudget) return TRUNCATION_MARKER;
    return observation.truncated === true ? ENGINE_TRUNCATION_MARKER : undefined;
  };
  const markerBytes = encoder.encode(`${markerFor(false) ?? TRUNCATION_MARKER}\n`).byteLength;
  const budget = Math.max(0, options.maxBytes - markerBytes);
  let bytes = 0;
  let cutByBudget = false;

  const emit = (node: SemanticNode, depth: number): void => {
    if (cutByBudget) return;
    const line = formatNode(node, depth, redact);
    const size = encoder.encode(`${line}\n`).byteLength;
    if (lines.length > 0 && bytes + size > budget) {
      cutByBudget = true;
      return;
    }
    bytes += size;
    lines.push(line);
    for (const child of node.children ?? []) emit(child, depth + 1);
  };
  emit(observation.tree, 0);
  const marker = markerFor(cutByBudget);
  if (marker !== undefined) lines.push(marker);
  const truncated = marker !== undefined;

  const text = lines.join('\n');
  // Every emitted line was measured with its newline; the join has one fewer
  // and the marker was measured up front, so the size is known without a
  // second pass over the whole tree text.
  const textBytes = Math.max(0, bytes + (marker === undefined ? 0 : encoder.encode(`${marker}\n`).byteLength) - 1);
  return {
    ...metadata,
    kind: 'semantic',
    text,
    bytes: textBytes,
    nodes,
    parents,
    tree: observation.tree,
    truncated,
    ...(pixels.cleared === undefined ? {} : { pixels: pixels.cleared }),
    ...(pixels.withheld === undefined ? {} : { pixelsWithheld: pixels.withheld }),
  };
}

/**
 * Trace and executor locations use the same capture, without a second engine
 * call: the address without its origin. What the fragment means, an anchor or
 * the route of an app that routes in it, is `cache/route.ts`'s to decide.
 */
function observationPath(location: string): string {
  if (!URL.canParse(location)) return location;
  const url = new URL(location);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Phase metrics describe a node count only when the capture actually read nodes. */
export function observationDetail(observation: AgentObservation): { count?: number; bytes: number } {
  return { bytes: observation.bytes, ...(observation.kind === 'semantic' ? { count: observation.nodes.size } : {}) };
}

/**
 * Clears captured pixels for model input, or withholds them.
 *
 * Every secure node the engine observed must be covered by a masked region.
 * When it is not, the engine masked less than it saw and the image cannot be
 * proven redacted, so it is dropped exactly like an incompletely redacted
 * artifact — the semantic tree still goes out.
 */
function clearPixels(observation: Observation): {
  cleared?: ExecutorPixels;
  withheld?: PixelsWithheld;
} {
  const pixels = observation.pixels;
  if (pixels === undefined) return {};
  const { secureNodeCount, maskedRegionCount } = observation.redaction;
  if (maskedRegionCount < secureNodeCount) return { withheld: 'MASKING_UNPROVEN' };
  return { cleared: { ...pixels, maskedRegionCount } };
}

/**
 * Whether requested pixels become model input, decided once per observation
 * for every tier that asks: a tainted viewport (a secret filled this attempt)
 * is denied first, since the secret may be anywhere on screen; then the
 * capture's own reasons; then the pixels themselves.
 */
export function pixelsForModel(
  observation: AgentObservation,
  tainted: boolean,
): { readonly pixels: ExecutorPixels } | { readonly withheld: VisionDegradation } {
  if (tainted) return { withheld: 'PIXEL_TAINTED' };
  if (observation.pixels === undefined) {
    return { withheld: observation.kind === 'semantic' ? observation.pixelsWithheld ?? 'UNSUPPORTED_CAPABILITY' : 'UNSUPPORTED_CAPABILITY' };
  }
  // Sized here, once per observation a model receives, not per capture: the
  // settle loop captures several times per action and only digests the bytes.
  return { pixels: sizeForModel(observation.pixels) };
}

/**
 * Roles the model can act on by id: the controls a hit-tested point resolves
 * to, and the lines that mark a screen as one the tree can drive at all.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'treeitem',
]);

/**
 * How many listed nodes the model could act on by id, read off the rendered
 * lines. A screen with none is one the tree cannot describe (a canvas, a
 * game, a native surface the platform exposes no semantics for), and the
 * model needs pixels from the first turn rather than a round trip to discover
 * that. Lives next to `formatNode` so the line grammar keeps one owner.
 */
export function interactiveNodeCount(observation: Pick<ExecutorObservation, 'text'>): number {
  let count = 0;
  for (const line of observation.text.split('\n')) {
    const role = /^\s*#\S+ (\S+)/.exec(line)?.[1];
    if (role !== undefined && INTERACTIVE_ROLES.has(role)) count += 1;
  }
  return count;
}

/**
 * Projects the raw tree onto the executor-facing node shape: the same
 * redaction the text serialization applies, field by field, and no value or
 * selection at all for a secure node. Selectors stay behind — they are relocation
 * material for the trace cache, not something a brain reasons about.
 */
export function projectTree(node: SemanticNode, redact: (text: string) => string): ExecutorNode {
  const secure = node.states?.secure === true;
  const attributes =
    node.attributes === undefined
      ? undefined
      : Object.fromEntries(Object.entries(node.attributes).map(([key, value]) => [key, redact(value)]));
  return {
    id: node.ref.id,
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.name === undefined ? {} : { name: redact(node.name) }),
    ...(node.text === undefined ? {} : { text: redact(node.text) }),
    ...(node.value === undefined || secure ? {} : { value: redact(node.value) }),
    ...(node.selection === undefined || secure ? {} : { selection: redact(node.selection) }),
    ...(node.inputPurpose === undefined ? {} : { inputPurpose: node.inputPurpose }),
    ...(node.states === undefined ? {} : { states: node.states }),
    ...(attributes === undefined ? {} : { attributes }),
    ...(node.rect === undefined ? {} : { rect: node.rect }),
    ...(node.framePath === undefined ? {} : { framePath: node.framePath }),
    ...(node.children === undefined
      ? {}
      : { children: node.children.map((child) => projectTree(child, redact)) }),
  };
}

/** Depth beyond this renders flat; deep chrome must not buy tokens with spaces. */
const MAX_INDENT_DEPTH = 10;

/**
 * Renders one node as `#id role "name" text="..." value="..." selection="..." [states]`. Role-less text
 * holders omit the role token entirely: on a large screen they are half the
 * lines, and the model needs their text, not a filler word.
 */
export function formatNode(
  node: SemanticNode,
  depth: number,
  redact: (text: string) => string,
): string {
  const parts: string[] = [`#${node.ref.id}`];
  if (node.role !== undefined && node.role !== '') parts.push(node.role);
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(redact(node.name)));
  const text = node.text === undefined ? '' : collapseText(node.text);
  if (text !== '' && text !== node.name) parts.push(`text=${JSON.stringify(redact(text))}`);
  // Disambiguators the model needs when role and name repeat. The engine has
  // already reduced href to origin and path.
  if (node.testId !== undefined && node.testId !== '') parts.push(`testid=${JSON.stringify(node.testId)}`);
  const href = node.attributes?.['href'];
  if (href !== undefined && href !== '') parts.push(`href=${JSON.stringify(redact(href))}`);
  const placeholder = node.attributes?.['placeholder'];
  if (placeholder !== undefined && placeholder !== '' && (node.name ?? '') === '') {
    parts.push(`placeholder=${JSON.stringify(redact(placeholder))}`);
  }
  if (node.states?.secure === true) {
    parts.push('value=<secure>');
  } else if (node.value !== undefined && node.value !== '') {
    parts.push(`value=${JSON.stringify(redact(node.value))}`);
  }
  // What a Shift+Arrow press selected: without it the model extends a
  // selection blind and cannot tell one word from its neighbour. Rendered
  // verbatim (escaped), since a selected space or newline is a selection too.
  if (node.selection !== undefined && node.selection !== '' && node.states?.secure !== true) {
    parts.push(`selection=${JSON.stringify(redact(node.selection))}`);
  }
  if (node.inputPurpose !== undefined && node.inputPurpose !== 'none') {
    parts.push(`purpose=${node.inputPurpose}`);
  }
  const states = Object.entries(node.states ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  if (states.length > 0) parts.push(`[${states.join(' ')}]`);
  return `${' '.repeat(Math.min(depth, MAX_INDENT_DEPTH))}${parts.join(' ')}`;
}

/**
 * What the screen looks like, independent of which observation looked at it.
 *
 * Three things are dropped. Node ids, because an engine may mint them per
 * observation, so two looks at a screen that has not moved would never render
 * identically. The focus state, because focus moves on its own — the platform
 * settling it after load, a script claiming it, a widget stealing it — without
 * the screen having changed in any way a judgment could answer differently
 * about. And clock-like values, because a ticking clock or countdown would
 * make every screen look changed: it would end the wait for an action's
 * effect on the first tick and keep a settle from ever seeing two looks agree.
 *
 * Lives next to `formatNode` so the line grammar keeps one owner.
 */
export function observationShape(observation: AgentObservation): string | undefined {
  if (observation.kind === 'pixels') return undefined;
  const text = observation.text
    .replaceAll(/(^|\n)(\s*)#\S+/g, '$1$2')
    .replaceAll(/ \[([^\]]*)\]/g, (_match, states: string) => {
      const stable = states.split(' ').filter((state) => state !== 'focused');
      return stable.length === 0 ? '' : ` [${stable.join(' ')}]`;
    })
    .replaceAll(CLOCK_PATTERN, '<time>');
  // A capture taken with pixels is shaped by them too: on a canvas, a map, or
  // a game the tree never moves, and without the pixels every action would
  // wait out the whole change window and then be reported as having done
  // nothing. A digest keeps the shape a string and the comparison cheap.
  const pixels = observation.pixels;
  return pixels === undefined ? text : `${text}\n<pixels ${pixelDigest(pixels.data)}>`;
}

/**
 * FNV-1a over the image bytes: fast, and equal frames encode to equal bytes.
 * The screen presenter compares consecutive screenshots with it too.
 */
export function pixelDigest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** `12:05`, `0:59`, `23:59:59`: a value that changes on its own once a second or minute. */
const CLOCK_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

/**
 * The shape an action's effect is waited for against. On a screen the tree
 * describes (any interactive node listed), the tree alone: a screenshot moves
 * on a focus ring or a hover the moment a control is tapped, and a change
 * wait that read that as the effect would return the old page as if the tap
 * had already landed. On a screen the tree cannot describe (a canvas, a
 * game) the pixels are the only place an effect can show, so they count.
 */
export function changeShape(observation: AgentObservation): string | undefined {
  if (observation.kind === 'pixels') return undefined;
  if (interactiveNodeCount(observation) > 0) return observationShape({ ...observation, pixels: undefined });
  return observationShape(observation);
}

/** Poll interval for shape-stability settling. */
const SETTLE_POLL_MS = 75;

/** What a settle loop needs from its step: the remaining clock and cancellation. */
interface SettleClock {
  remainingMs(): number;
  readonly signal: AbortSignal;
}

/**
 * The shape the screen had when the preceding action was resolved, and
 * the deadline for the screen to leave it: the action's settle policy
 * (`settle-policy.ts`) decides the window, armed once the action commits.
 */
export interface PendingChange {
  readonly shape: string;
  readonly deadlineMs: number;
}

/** The waits of one settle, decided by the caller; the loop itself keeps no defaults for them. */
export interface SettleOptions<T> {
  /**
   * The pre-action shape to leave first, when an action is pending. The
   * settle waits, bounded by its window, for the shape to differ from it, so
   * an action's result is read after its effect rather than before.
   */
  readonly changedFrom?: PendingChange | undefined;
  /** The shape `changedFrom` is compared against; defaults to `shapeOf`. */
  readonly changeShapeOf?: ((value: T) => string | undefined) | undefined;
  /**
   * Whether a capture is a screen in transition rather than a screen: an
   * empty document between two pages, say. After an action, such a capture
   * satisfies neither the change wait nor the subsequent stability check.
   */
  readonly transitional?: ((value: T) => boolean) | undefined;
  /**
   * How long the loop proves the new shape holds still: captures a poll
   * apart until two agree, or this runs out. Zero reads the first capture
   * past the change wait as it is.
   */
  readonly stableWaitMs: number;
  readonly pollMs?: number | undefined;
}

/**
 * Captures until the screen shape holds still, bounded by a short ceiling and
 * the step clock. An observation taken right after an action can be a
 * snapshot the app is still reacting to — a fetch-backed mutation re-renders
 * long after the action resolves — and acting or judging on it repeats
 * actions and passes steps on pre-render state. The executor-facing observe
 * (act.ts) settles through this loop, and replay's pre-action looks and the
 * cache session's probes reach it through that same observe, so the pacing
 * can never drift between them.
 *
 * With `changedFrom`, the loop has two phases: first it waits for the shape
 * to leave the pre-action one (a navigation committing, a route swapping the
 * body, a submit rendering), then it waits for the new shape to hold still.
 * A screen that never leaves the pre-action shape is returned as it is once
 * the change wait runs out: the caller reports it unchanged rather than
 * guessing. Evidence with no comparable shape returns immediately; another
 * capture cannot establish semantic stability while semantics are unavailable.
 */
export async function settleObservation<T>(
  capture: () => Promise<T>,
  shapeOf: (value: T) => string | undefined,
  clock: SettleClock,
  options: SettleOptions<T>,
): Promise<T> {
  const pollMs = options.pollMs ?? SETTLE_POLL_MS;
  const transitional = options.transitional ?? (() => false);
  let value = await capture();
  let shape = shapeOf(value);
  if (shape === undefined) return value;
  if (options.changedFrom !== undefined) {
    const changeShapeOf = options.changeShapeOf ?? shapeOf;
    while (
      (changeShapeOf(value) === options.changedFrom.shape || transitional(value)) &&
      Date.now() < options.changedFrom.deadlineMs &&
      clock.remainingMs() > pollMs
    ) {
      await sleep(pollMs, clock.signal);
      value = await capture();
      shape = shapeOf(value);
      if (shape === undefined) return value;
    }
  }
  const deadlineMs = Date.now() + options.stableWaitMs;
  while (Date.now() < deadlineMs && clock.remainingMs() > pollMs) {
    await sleep(pollMs, clock.signal);
    value = await capture();
    const next = shapeOf(value);
    if (next === undefined) return value;
    const stable = next === shape;
    shape = next;
    if (stable && (options.changedFrom === undefined || !transitional(value))) break;
  }
  return value;
}

/**
 * Whether an observation shows a screen in transition: nothing but the
 * document, screen, or window root, between the old content being torn down and the
 * new content arriving. Acting or judging on it would be acting on nothing.
 */
export function isTransitionalObservation(observation: AgentObservation): boolean {
  return observation.kind === 'semantic' &&
    (observation.tree.role === 'document' || observation.tree.role === 'screen' || observation.tree.role === 'window') &&
    observation.nodes.size <= 1;
}

function indexNodes(
  node: SemanticNode,
  into: Map<string, SemanticNode>,
  parents: Map<string, string>,
): void {
  into.set(node.ref.id, node);
  for (const child of node.children ?? []) {
    parents.set(child.ref.id, node.ref.id);
    indexNodes(child, into, parents);
  }
}
