/** Observation capture, redaction, and model serialization (spec 09-drivers.md, 14-security.md). */

import type { Observation, ObservationPixels, SemanticNode } from '../driver/index.ts';
import { sanitizeText } from '../internal/errors.ts';
import { sleep } from '../internal/time.ts';
import { AgentError } from './error.ts';

/** Appended when the node walk stopped at the observation byte budget. */
const TRUNCATION_MARKER = '[observation truncated at the resolved observation byte limit]';

/** Why pixels the caller asked for are not part of this observation. */
export type PixelsWithheld = 'MASKING_UNPROVEN';

/** Masked pixel evidence cleared for model input. */
export interface AgentPixels extends ObservationPixels {
  readonly maskedRegionCount: number;
  readonly bytes: number;
}

export interface AgentObservation {
  readonly revision: string;
  /** Redacted, size-bounded serialization sent to the model. */
  readonly text: string;
  readonly bytes: number;
  readonly nodes: ReadonlyMap<string, SemanticNode>;
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
  readonly truncated: boolean;
  /** Present only when the driver captured pixels and masking checks out. */
  readonly pixels?: AgentPixels | undefined;
  /** Set when captured pixels were dropped instead of being sent. */
  readonly pixelsWithheld?: PixelsWithheld | undefined;
}

/**
 * Turns one raw driver observation into redacted model input.
 *
 * An observation whose masking the driver cannot prove is rejected before it
 * reaches a model or disk. Registered secret values are additionally replaced
 * by their stable secret name.
 */
export function prepareObservation(
  observation: Observation,
  options: {
    redact: (text: string) => string;
    maxBytes: number;
    testIdAttribute: string;
  },
): AgentObservation {
  if (!observation.redaction.complete) {
    throw new AgentError(
      'POLICY_DENIED',
      'the driver could not prove observation masking is complete; the observation was discarded',
    );
  }

  const nodes = new Map<string, SemanticNode>();
  indexNodes(observation.tree, nodes);

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
  const pixels = clearPixels(observation);
  return {
    revision: observation.revision,
    text,
    bytes: encoder.encode(text).byteLength,
    nodes,
    viewport: observation.viewport,
    truncated,
    ...(pixels.cleared === undefined ? {} : { pixels: pixels.cleared }),
    ...(pixels.withheld === undefined ? {} : { pixelsWithheld: pixels.withheld }),
  };
}

/**
 * Clears captured pixels for model input, or withholds them.
 *
 * Every secure node the driver observed must be covered by a masked region.
 * When it is not, the driver masked less than it saw and the image cannot be
 * proven redacted, so it is dropped exactly like an incompletely redacted
 * artifact (14-security.md) — the semantic tree still goes out.
 */
function clearPixels(observation: Observation): {
  cleared?: AgentPixels;
  withheld?: PixelsWithheld;
} {
  const pixels = observation.pixels;
  if (pixels === undefined) return {};
  const { secureNodeCount, maskedRegionCount } = observation.redaction;
  if (maskedRegionCount < secureNodeCount) return { withheld: 'MASKING_UNPROVEN' };
  return { cleared: { ...pixels, maskedRegionCount, bytes: pixels.data.byteLength } };
}

/** Depth beyond this renders flat; deep chrome must not buy tokens with spaces. */
const MAX_INDENT_DEPTH = 10;

/**
 * Renders one node as `#id role "name" text="..." [states]`. Role-less text
 * holders omit the role token entirely: on a large page they are half the
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
  const text = node.text === undefined ? '' : collapse(node.text);
  if (text !== '' && text !== node.name) parts.push(`text=${JSON.stringify(redact(text))}`);
  // Disambiguators the model needs when role and name repeat. The driver has
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
 * What the page looks like, independent of which observation looked at it.
 *
 * Two things are dropped. Node ids, because they are minted per observation, so
 * two looks at a page that has not moved would never render identically. And
 * the focus state, because focus moves on its own — the browser settling it
 * after load, a script claiming it, a widget stealing it — without the page
 * having changed in any way a judgment could answer differently about. Leaving
 * it in meant a genuinely static page could still spend a second model call.
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
export const SETTLE_POLL_MS = 75;
export const SETTLE_TIMEOUT_MS = 1_000;

/** What a settle loop needs from its step: the remaining clock and cancellation. */
export interface SettleClock {
  remainingMs(): number;
  readonly signal: AbortSignal;
}

/**
 * Captures until the page shape holds still, bounded by a short ceiling and
 * the step clock. An observation taken right after an action can be a
 * snapshot the app is still reacting to — a fetch-backed mutation re-renders
 * long after the action resolves — and acting or judging on it repeats
 * actions and passes steps on pre-render state. Both the executor-facing
 * observe (act.ts) and replay's pre-action wait (replay.ts) settle through
 * this one loop, so the pacing can never drift between them.
 */
export async function settleObservation<T>(
  capture: () => Promise<T>,
  shapeOf: (value: T) => string | undefined,
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

function collapse(text: string): string {
  return sanitizeText(text).replace(/\s+/g, ' ').trim();
}

function indexNodes(node: SemanticNode, into: Map<string, SemanticNode>): void {
  into.set(node.ref.id, node);
  for (const child of node.children ?? []) indexNodes(child, into);
}
