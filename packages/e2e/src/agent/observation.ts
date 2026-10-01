/** Observation capture, redaction, and model serialization. */

import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT } from '../engine/contract.ts';
import type { Observation, SemanticNode, ViewportSize } from '../engine/surface.ts';
import type { SecretLedger } from '../internal/redact.ts';
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
      readonly nodes: ReadonlyMap<string, RedactedNode>;
      readonly parents: ReadonlyMap<string, string>;
      readonly tree: RedactedNode;
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
 * tree never carries secure values. Every string of every node is redacted
 * once, here (`redactNode`): registered secret values are replaced by their
 * stable secret name, and so is the leading part of one a field the engine
 * cut at its limit ends with. A field holding one keeps no selection, as a
 * secure field keeps none.
 */
export function prepareObservation(
  observation: Observation,
  options: {
    redact: (text: string) => string;
    /** `redact` for a field cut at its observed limit (`SecretLedger.redactCut`). */
    redactCut: (text: string) => string;
    maxBytes: number;
    /** Grants pixel-only evidence; omit when this consumer cannot use it. */
    pixelsAllowed?: boolean;
    /** The app base URL's origin: link targets on it render as paths, which navigation resolves against it. */
    appOrigin?: string | undefined;
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
  const tree = redactNode(observation.tree, options);
  const nodes = new Map<string, RedactedNode>();
  const parents = new Map<string, string>();
  indexNodes(tree, nodes, parents);

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

  const emit = (node: RedactedNode, depth: number): void => {
    if (cutByBudget) return;
    const line = formatNode(node, depth, options.appOrigin);
    const size = encoder.encode(`${line}\n`).byteLength;
    if (lines.length > 0 && bytes + size > budget) {
      cutByBudget = true;
      return;
    }
    bytes += size;
    lines.push(line);
    for (const child of node.children ?? []) emit(child, depth + 1);
  };
  emit(tree, 0);
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
    tree,
    truncated,
    ...(pixels.cleared === undefined ? {} : { pixels: pixels.cleared }),
    ...(pixels.withheld === undefined ? {} : { pixelsWithheld: pixels.withheld }),
  };
}

/** What redacts a node: whole values, and the leading part of one a cut field ends with. */
export type NodeRedaction = Pick<SecretLedger, 'redact' | 'redactCut'>;

declare const REDACTED: unique symbol;

/**
 * A semantic node every string of which has passed the attempt's secret
 * ledger (`redactNode`). Model-facing text and executor trees render only
 * from this shape, so a node no redaction touched cannot reach them.
 */
export interface RedactedNode extends Omit<SemanticNode, 'children'> {
  readonly [REDACTED]: true;
  readonly children?: readonly RedactedNode[];
}

type NodeField = Exclude<keyof SemanticNode, 'children'>;

/** One field's redaction: its value with every secret taken out, or undefined to drop it. */
type FieldRedaction<Field extends NodeField> = (
  value: NonNullable<SemanticNode[Field]>,
  node: SemanticNode,
  redaction: NodeRedaction,
) => SemanticNode[Field] | undefined;

/** Leaves a field the engine fills from a closed set (an enum, booleans, numbers) or mints itself as it is. */
const keep = <Value>(value: Value): Value => value;

/**
 * How each field of a node is redacted, one entry per field of
 * `SemanticNode`: a field added to the contract does not compile until it
 * says how its text is redacted, and a key an engine sends that the
 * contract does not name is dropped. Every string passes through
 * `redactText`. A secure node keeps no value or selection, and a selection
 * that may show part of a secret is dropped, as a secure field's is. The ref
 * is the engine's own handle, sent back to it to act, never page text.
 */
const NODE_FIELDS: { readonly [Field in NodeField]-?: FieldRedaction<Field> } = {
  ref: keep,
  role: (role, _node, redaction) => redactText(role, redaction),
  name: (name, _node, redaction) => redactText(name, redaction, OBSERVED_NAME_LIMIT),
  text: (text, _node, redaction) => redactText(text, redaction, OBSERVED_TEXT_LIMIT),
  value: (value, node, redaction) => (node.states?.secure === true ? undefined : redactText(value, redaction, OBSERVED_TEXT_LIMIT)),
  selection: (selection, node, redaction) =>
    node.states?.secure === true || selectionMayHoldSecret(node, selection, redaction)
      ? undefined
      : redactText(selection, redaction, OBSERVED_TEXT_LIMIT),
  testId: (testId, _node, redaction) => redactText(testId, redaction),
  inputPurpose: keep,
  states: keep,
  level: keep,
  attributes: (attributes, _node, redaction) =>
    Object.fromEntries(Object.entries(attributes).map(([key, value]) => [redactText(key, redaction), redactText(value, redaction)])),
  rect: keep,
  selector: (selector, _node, redaction) => redactText(selector, redaction),
  framePath: (framePath, _node, redaction) => framePath.map((selector) => redactText(selector, redaction)),
};

/**
 * The node and its subtree with every secret taken out of every field
 * (`NODE_FIELDS`), before any consumer reads it: the model's text, the
 * executor's tree, cache descriptors and anchors, failure evidence.
 */
export function redactNode(node: SemanticNode, redaction: NodeRedaction): RedactedNode {
  const redacted: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(node)) {
    if (field === 'children' || value === undefined || !Object.hasOwn(NODE_FIELDS, field)) continue;
    const redactValue = NODE_FIELDS[field as NodeField] as FieldRedaction<NodeField>;
    const result = redactValue(value as never, node, redaction);
    if (result !== undefined) redacted[field] = result;
  }
  if (node.children !== undefined) redacted['children'] = node.children.map((child) => redactNode(child, redaction));
  return redacted as unknown as RedactedNode;
}

/**
 * An earlier capture's nodes redacted again through the ledger as it is now,
 * each on its own fields, then linked to its redacted-again children, so the
 * tree keeps its shape (which nodes are leaves) without a subtree redacted
 * once per ancestor. A secret a provider resolved after the capture masks
 * text the capture still shows, so the two captures read alike wherever the
 * screen did not change. Redacting redacted text changes nothing else: a
 * marker is never read again.
 */
export function redactNodesAgain(
  nodes: ReadonlyMap<string, RedactedNode>,
  redaction: NodeRedaction,
): ReadonlyMap<string, RedactedNode> {
  const again = new Map<string, { children?: readonly RedactedNode[] } & RedactedNode>();
  for (const [id, { children: _children, ...fields }] of nodes) again.set(id, redactNode(fields, redaction));
  for (const [id, { children }] of nodes) {
    const node = again.get(id);
    if (node === undefined || children === undefined) continue;
    node.children = children.map((child) => again.get(child.ref.id)).filter((child) => child !== undefined);
  }
  return again;
}

/**
 * One observed string with every secret taken out, in the form it is written
 * and in the one-line form a line, a descriptor, or an anchor shows it
 * (`collapseText`). A field exactly as long as `limit`, and so possibly cut
 * there, passes through `redactCut`: a secret the cut stopped partway through
 * leaves a leading part at the end that no whole value matches. A shorter
 * field is whole, and so is a longer one (a native input's value, which no
 * engine cuts); both pass through `redact`. A field whose collapsed form
 * still holds a secret (the whitespace inside a value widened) is kept
 * collapsed and redacted, so no later collapse brings the value back.
 */
function redactText(text: string, redaction: NodeRedaction, limit?: number): string {
  const pass = text.length === limit ? redaction.redactCut : redaction.redact;
  const redacted = pass(text);
  const collapsed = collapseText(redacted);
  if (collapsed === redacted) return redacted;
  const read = pass(collapsed);
  return read === collapsed ? redacted : read;
}

/**
 * Whether a node's selection may show part of a secret, which no whole-value
 * match sees in it: its value or text holds one, whole or cut short at the
 * end; or one of them was cut and the selection lies in neither, so it may
 * come from the cut-off rest, which the runner never sees. The page never
 * learns the secrets: the check is redaction changing the field.
 */
function selectionMayHoldSecret(node: SemanticNode, selection: string, redaction: NodeRedaction): boolean {
  const fields = [node.value, node.text].filter((text) => text !== undefined);
  const cut = (text: string): boolean => text.length === OBSERVED_TEXT_LIMIT;
  if (fields.some((text) => redactText(text, redaction, OBSERVED_TEXT_LIMIT) !== text)) return true;
  return fields.some(cut) && !fields.some((text) => text.includes(selection));
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
  'listbox',
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
 * Projects a redacted tree onto the executor-facing node shape, the fields
 * the text serialization renders, with a link target bounded as a line
 * bounds it: a target on `appOrigin` keeps that origin and loses no more of
 * its path than the line does. Selectors stay behind — they are relocation
 * material for the trace cache, not something a brain reasons about.
 */
export function projectTree(node: RedactedNode, appOrigin?: string): ExecutorNode {
  const attributes =
    node.attributes === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(node.attributes).map(([key, value]) => [key, key === 'href' ? treeHref(value, appOrigin) : value]),
        );
  return {
    id: node.ref.id,
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(node.value === undefined ? {} : { value: node.value }),
    ...(node.selection === undefined ? {} : { selection: node.selection }),
    ...(node.inputPurpose === undefined ? {} : { inputPurpose: node.inputPurpose }),
    ...(node.states === undefined ? {} : { states: node.states }),
    ...(attributes === undefined ? {} : { attributes }),
    ...(node.rect === undefined ? {} : { rect: node.rect }),
    ...(node.framePath === undefined ? {} : { framePath: node.framePath }),
    ...(node.children === undefined ? {} : { children: node.children.map((child) => projectTree(child, appOrigin)) }),
  };
}

/** Depth beyond this renders flat; deep chrome must not buy tokens with spaces. */
const MAX_INDENT_DEPTH = 10;

/** Link target UTF-16 units a line shows; a longer target is cut there and ends with `…`. */
const MAX_HREF_LENGTH = 256;

/**
 * Renders one node as `#id role "name" text="..." value="..." selection="..." [states]`. Role-less text
 * holders omit the role token entirely: on a large screen they are half the
 * lines, and the model needs their text, not a filler word. A link target on
 * `appOrigin`, the app base URL's, renders as its path.
 */
export function formatNode(node: RedactedNode, depth: number, appOrigin?: string): string {
  const parts: string[] = [`#${node.ref.id}`];
  if (node.role !== undefined && node.role !== '') parts.push(node.role);
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(node.name));
  const text = node.text === undefined ? '' : collapseText(node.text);
  if (text !== '' && text !== node.name) parts.push(`text=${JSON.stringify(text)}`);
  // Disambiguators the model needs when role and name repeat. The engine has
  // already reduced href to origin and path.
  if (node.testId !== undefined && node.testId !== '') parts.push(`testid=${JSON.stringify(node.testId)}`);
  const href = node.attributes?.['href'];
  if (href !== undefined && href !== '') parts.push(`href=${JSON.stringify(renderHref(href, appOrigin))}`);
  const placeholder = node.attributes?.['placeholder'];
  if (placeholder !== undefined && placeholder !== '' && (node.name ?? '') === '') {
    parts.push(`placeholder=${JSON.stringify(placeholder)}`);
  }
  if (node.states?.secure === true) {
    parts.push('value=<secure>');
  } else if (node.value !== undefined && node.value !== '') {
    parts.push(`value=${JSON.stringify(node.value)}`);
  }
  // What a Shift+Arrow press selected: without it the model extends a
  // selection blind and cannot tell one word from its neighbour. Rendered
  // verbatim (escaped), since a selected space or newline is a selection too.
  if (node.selection !== undefined && node.selection !== '') {
    parts.push(`selection=${JSON.stringify(node.selection)}`);
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
 * A link target as a line shows it: a path when it is on the app's origin,
 * the one a navigation to a path resolves against, else the whole URL, since
 * a path on another site would send the model back to the app. Bounded by
 * `boundHref`, after redaction.
 */
function renderHref(href: string, appOrigin: string | undefined): string {
  return boundHref(onOrigin(href, appOrigin) ? href.slice(appOrigin.length) : href);
}

/** A link target as an executor tree carries it: absolute, and bounded exactly as `renderHref` bounds the line. */
function treeHref(href: string, appOrigin: string | undefined): string {
  return onOrigin(href, appOrigin) ? `${appOrigin}${renderHref(href, appOrigin)}` : boundHref(href);
}

/** Whether a link target is on `origin`. */
function onOrigin(href: string, origin: string | undefined): origin is string {
  return origin !== undefined && href.startsWith(`${origin}/`);
}

/**
 * A redacted link target cut at `MAX_HREF_LENGTH` with a trailing `…`, so a
 * cut target never reads as whole; the cut never splits a surrogate pair.
 * Redaction runs first, so the cut never leaves part of a secret.
 */
function boundHref(href: string): string {
  if (href.length <= MAX_HREF_LENGTH) return href;
  const end = /[\uD800-\uDBFF]/.test(href.charAt(MAX_HREF_LENGTH - 1)) ? MAX_HREF_LENGTH - 1 : MAX_HREF_LENGTH;
  return `${href.slice(0, end)}…`;
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
 * Whether an observation shows a screen in transition: only an empty root,
 * with no permitted screenshot to describe content absent from the tree.
 * A canvas can have an empty tree while its pixels show the action's effect.
 */
export function isTransitionalObservation(observation: AgentObservation): boolean {
  return observation.kind === 'semantic' &&
    observation.pixels === undefined &&
    (observation.tree.role === 'document' || observation.tree.role === 'screen' || observation.tree.role === 'window') &&
    observation.nodes.size <= 1;
}

function indexNodes(
  node: RedactedNode,
  into: Map<string, RedactedNode>,
  parents: Map<string, string>,
): void {
  into.set(node.ref.id, node);
  for (const child of node.children ?? []) {
    parents.set(child.ref.id, node.ref.id);
    indexNodes(child, into, parents);
  }
}
