/** Observation capture, redaction, and model serialization (spec 09-drivers.md, 14-security.md). */

import type { Observation, SemanticNode } from '../backend/surface.ts';
import { collapseText } from '../internal/text.ts';
import { sleep } from '../internal/time.ts';
import type { VisionDegradation } from '../run/steps.ts';
import type { ExecutorNode, ExecutorPixels } from './executor.ts';

/** Appended when the node walk stopped at the observation byte budget. */
const TRUNCATION_MARKER = '[observation truncated at the resolved observation byte limit]';

/** Why pixels the caller asked for are not part of this observation. */
type PixelsWithheld = 'MASKING_UNPROVEN';

export interface AgentObservation {
  /** Location captured with this tree, when the backend can provide it. */
  readonly url?: string;
  readonly revision: string;
  /** Redacted, size-bounded serialization sent to the model. */
  readonly text: string;
  readonly bytes: number;
  readonly nodes: ReadonlyMap<string, SemanticNode>;
  /** Parent id of every non-root node, for the container a target sits in. */
  readonly parents: ReadonlyMap<string, string>;
  /** The raw tree as the backend reported it; redacted only on the way out. */
  readonly tree: SemanticNode;
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
  readonly truncated: boolean;
  /** Present only when the backend captured pixels and masking checks out. */
  readonly pixels?: ExecutorPixels | undefined;
  /** Set when captured pixels were dropped instead of being sent. */
  readonly pixelsWithheld?: PixelsWithheld | undefined;
}

/**
 * Turns one raw backend observation into redacted model input.
 *
 * Pixels whose masking the backend cannot prove (fewer masked regions than
 * secure nodes) are withheld before they reach a model or disk; the semantic
 * tree never carries secure values. Registered secret values are additionally
 * replaced by their stable secret name.
 */
export function prepareObservation(
  observation: Observation,
  options: {
    redact: (text: string) => string;
    maxBytes: number;
    testIdAttribute: string;
  },
): AgentObservation {
  const nodes = new Map<string, SemanticNode>();
  const parents = new Map<string, string>();
  indexNodes(observation.tree, nodes, parents);

  const redact = options.redact;
  const lines: string[] = [];
  const encoder = new TextEncoder();
  // The marker is reserved up front so a truncated observation still fits the
  // budget; the budget is what keeps the request under the token ceiling.
  const markerBytes = encoder.encode(`${TRUNCATION_MARKER}\n`).byteLength;
  const budget = Math.max(0, options.maxBytes - markerBytes);
  let bytes = 0;
  let truncated = false;

  const emit = (node: SemanticNode, depth: number): void => {
    if (truncated) return;
    const line = formatNode(node, depth, redact, options.testIdAttribute);
    const size = encoder.encode(`${line}\n`).byteLength;
    if (lines.length > 0 && bytes + size > budget) {
      truncated = true;
      return;
    }
    bytes += size;
    lines.push(line);
    for (const child of node.children ?? []) emit(child, depth + 1);
  };
  emit(observation.tree, 0);
  if (truncated) lines.push(TRUNCATION_MARKER);

  const text = lines.join('\n');
  // Every emitted line was measured with its newline; the join has one fewer
  // and the marker was measured up front, so the size is known without a
  // second pass over the whole tree text.
  const textBytes = Math.max(0, bytes + (truncated ? markerBytes : 0) - 1);
  const pixels = clearPixels(observation);
  return {
    revision: observation.revision,
    ...(observation.url === undefined ? {} : { url: options.redact(observation.url) }),
    text,
    bytes: textBytes,
    nodes,
    parents,
    tree: observation.tree,
    viewport: observation.viewport,
    truncated,
    ...(pixels.cleared === undefined ? {} : { pixels: pixels.cleared }),
    ...(pixels.withheld === undefined ? {} : { pixelsWithheld: pixels.withheld }),
  };
}

/**
 * Clears captured pixels for model input, or withholds them.
 *
 * Every secure node the backend observed must be covered by a masked region.
 * When it is not, the backend masked less than it saw and the image cannot be
 * proven redacted, so it is dropped exactly like an incompletely redacted
 * artifact (14-security.md) — the semantic tree still goes out.
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
    return { withheld: observation.pixelsWithheld ?? 'UNSUPPORTED_CAPABILITY' };
  }
  return { pixels: observation.pixels };
}

/**
 * Projects the raw tree onto the executor-facing node shape: the same
 * redaction the text serialization applies, field by field, and no value at
 * all for a secure node. Selectors stay behind — they are relocation
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
 * Renders one node as `#id role "name" text="..." [states]`. Role-less text
 * holders omit the role token entirely: on a large screen they are half the
 * lines, and the model needs their text, not a filler word.
 */
function formatNode(
  node: SemanticNode,
  depth: number,
  redact: (text: string) => string,
  testIdAttribute: string,
): string {
  const parts: string[] = [`#${node.ref.id}`];
  if (node.role !== undefined && node.role !== '') parts.push(node.role);
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(redact(node.name)));
  const text = node.text === undefined ? '' : collapseText(node.text);
  if (text !== '' && text !== node.name) parts.push(`text=${JSON.stringify(redact(text))}`);
  // Disambiguators the model needs when role and name repeat. The backend has
  // already reduced href to origin and path.
  const testId = node.attributes?.[testIdAttribute];
  if (testId !== undefined && testId !== '') parts.push(`testid=${JSON.stringify(testId)}`);
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
 * Two things are dropped. Node ids, because they are minted per observation, so
 * two looks at a screen that has not moved would never render identically. And
 * the focus state, because focus moves on its own — the platform settling it
 * after load, a script claiming it, a widget stealing it — without the screen
 * having changed in any way a judgment could answer differently about. Leaving
 * it in meant a genuinely static screen could still spend a second model call.
 *
 * Lives next to `formatNode` so the line grammar keeps one owner.
 */
export function observationShape(observation: AgentObservation): string {
  return observation.text
    .replaceAll(/(^|\n)(\s*)#\S+/g, '$1$2')
    .replaceAll(/ \[([^\]]*)\]/g, (_match, states: string) => {
      const stable = states.split(' ').filter((state) => state !== 'focused');
      return stable.length === 0 ? '' : ` [${stable.join(' ')}]`;
    });
}

/** Poll interval and ceiling for shape-stability settling. */
const SETTLE_POLL_MS = 75;
const SETTLE_TIMEOUT_MS = 1_000;

/** What a settle loop needs from its step: the remaining clock and cancellation. */
interface SettleClock {
  remainingMs(): number;
  readonly signal: AbortSignal;
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
 */
export async function settleObservation<T>(
  capture: () => Promise<T>,
  shapeOf: (value: T) => string,
  clock: SettleClock,
): Promise<T> {
  let value = await capture();
  let shape = shapeOf(value);
  const deadlineMs = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadlineMs && clock.remainingMs() > SETTLE_POLL_MS) {
    await sleep(SETTLE_POLL_MS, clock.signal);
    value = await capture();
    const next = shapeOf(value);
    const stable = next === shape;
    shape = next;
    if (stable) break;
  }
  return value;
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
