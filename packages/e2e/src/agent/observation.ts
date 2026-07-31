/** Observation capture, redaction, and model serialization (spec 09-drivers.md, 14-security.md). */

import type { Observation, ObservationPixels, SemanticNode } from '../driver/index.ts';
import { sanitizeText } from '../internal/errors.ts';
import { createRedactor } from '../internal/redact.ts';
import { AgentError } from './error.ts';

/** Appended when the node walk stopped at the observation byte budget. */
const TRUNCATION_MARKER =
  '[observation truncated at the resolved observation byte limit; what is on screen was kept ' +
  'in preference to what is scrolled out of view]';

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
    secrets: ReadonlyMap<string, string>;
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

  const redact = createRedactor(options.secrets);
  const encoder = new TextEncoder();
  // The marker is reserved up front so a truncated observation still fits the
  // budget; the budget is what keeps the request under the token ceiling.
  const markerBytes = encoder.encode(`${TRUNCATION_MARKER}\n`).byteLength;
  const budget = Math.max(0, options.maxBytes - markerBytes);

  // Rendered in two passes over one document order.
  //
  // The first builds every line's descriptive part; the second adds the node id,
  // the indent, and the placement, then spends the byte budget. Two passes
  // because a line that reads exactly like another one is a line the model cannot
  // choose between, and that is only knowable after all of them exist. Duplicates
  // are detected on the rendered text rather than against a list of roles worth
  // disambiguating: whatever two identical lines happen to be, the problem is the
  // same.
  const rendered: Rendered[] = [];
  const collect = (node: SemanticNode, depth: number, parent: number): void => {
    const index = rendered.length;
    rendered.push({
      node,
      depth,
      parent,
      body: describeNode(node, redact, options.testIdAttribute),
    });
    for (const child of node.children ?? []) collect(child, depth + 1, index);
  };
  collect(observation.tree, 0, -1);

  // Keyed without the volatile states, because the case that needs
  // disambiguating most is a control the agent has just interacted with: the
  // button it already pressed carries `focused` and would otherwise count as
  // unique against the identical one it should be choosing instead.
  const occurrences = new Map<string, number>();
  for (const entry of rendered) {
    const key = withoutVolatileStates(entry.body);
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  const sizes = rendered.map((entry) => {
    const line = formatLine(entry.node, entry.depth, entry.body, observation.viewport, {
      ambiguous: (occurrences.get(withoutVolatileStates(entry.body)) ?? 0) > 1,
    });
    return { line, size: encoder.encode(`${line}\n`).byteLength };
  });

  const selected = selectWithin(sizes, rendered, observation.viewport, budget);
  const lines = selected.indices.map((index) => sizes[index]!.line);
  const truncated = selected.dropped;
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

/** One node, rendered, with the parent it hangs off. */
interface Rendered {
  readonly node: SemanticNode;
  readonly depth: number;
  /** Index in the same array, or -1 for the root. */
  readonly parent: number;
  readonly body: string;
}

/**
 * Chooses which rendered lines fit the byte budget.
 *
 * Document order is the right order to *read* the tree in, and for anything that
 * fits it is also the right order to fill the budget in — so a page under budget
 * takes the fast path and this decides nothing.
 *
 * Over budget, document order is actively wrong. A dialog, a drawer, or a sheet is
 * appended at the end of the body, which makes the thing the user is looking at the
 * first thing dropped. That is not a hypothetical ordering concern: on a real
 * booking page the tap that opens the reservation dialog pushes the original button
 * off the top of the viewport and renders the live one inside the dialog, and at
 * 32 KiB the dialog fell past the cut. Every round after that, the only actionable
 * control the model could see was the dead one it had already pressed, so it pressed
 * it again until the invocation gave up. The observation reported itself truncated
 * the whole time, which says nothing about *what* went missing.
 *
 * So when the budget binds, what is on screen is kept first, together with the
 * ancestors that give it its place in the tree, and the remaining budget goes to
 * off-screen content in document order. Output stays in document order either way.
 *
 * A driver that reports no geometry cannot be prioritized and keeps the old
 * behaviour exactly: every node is equally a candidate, filled in document order.
 */
function selectWithin(
  sizes: readonly { readonly line: string; readonly size: number }[],
  rendered: readonly Rendered[],
  viewport: Observation['viewport'],
  budget: number,
): { readonly indices: readonly number[]; readonly dropped: boolean } {
  const all = sizes.reduce((total, entry) => total + entry.size, 0);
  if (all <= budget) return { indices: sizes.map((_entry, index) => index), dropped: false };

  const onScreen = new Set<number>();
  for (const [index, entry] of rendered.entries()) {
    const rect = entry.node.rect;
    if (rect === undefined) continue;
    if (offscreenDirection(rect, viewport) !== undefined) continue;
    // Ancestors come too: a line indented under nothing reads as a sibling of the
    // document, which misplaces it in exactly the tree the model is navigating.
    for (let at = index; at >= 0; at = rendered[at]!.parent) onScreen.add(at);
  }

  const fill = (candidates: readonly number[], kept: Set<number>, used: number): number => {
    let spent = used;
    for (const index of candidates) {
      if (kept.has(index)) continue;
      const size = sizes[index]!.size;
      if (kept.size > 0 && spent + size > budget) continue;
      kept.add(index);
      spent += size;
    }
    return spent;
  };

  const kept = new Set<number>();
  const ordered = sizes.map((_entry, index) => index);
  const spent = fill(
    ordered.filter((index) => onScreen.has(index)),
    kept,
    0,
  );
  fill(ordered, kept, spent);
  return {
    indices: ordered.filter((index) => kept.has(index)),
    dropped: kept.size < sizes.length,
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
 * States that move on their own, without the page offering anything different.
 *
 * Focus is claimed by the browser settling after load, by a script, by a widget,
 * and by the runner's own last action. Two places have to ignore it and they must
 * agree: the shape that decides whether the screen changed, and the key that
 * decides whether two lines are indistinguishable.
 */
const VOLATILE_STATES: ReadonlySet<string> = new Set(['focused']);

/** One rendered description with its volatile states removed. */
function withoutVolatileStates(body: string): string {
  return body.replaceAll(/ \[([^\]]*)\]/g, (_match, states: string) => {
    const stable = states.split(' ').filter((state) => !VOLATILE_STATES.has(state));
    return stable.length === 0 ? '' : ` [${stable.join(' ')}]`;
  });
}

/**
 * How far outside the viewport a node has to sit before it is worth saying so.
 *
 * A control flush against an edge, or one a pixel over it, is still the control
 * the user is looking at. The threshold keeps the marker for nodes that are
 * genuinely somewhere else on the page.
 */
const OFFSCREEN_SLACK = 4;

/**
 * Renders one node's description: everything except its id, indent, and place on
 * the page. Role-less text holders omit the role token entirely: on a large page
 * they are half the lines, and the model needs their text, not a filler word.
 *
 * The id is deliberately not part of this, so two nodes that a reader could not
 * tell apart produce the same string and can be found by comparing them.
 */
function describeNode(
  node: SemanticNode,
  redact: (text: string) => string,
  testIdAttribute: string,
): string {
  const parts: string[] = [];
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
  return parts.join(' ');
}

/** Assembles one full line: `  #id <description> <placement>`. */
function formatLine(
  node: SemanticNode,
  depth: number,
  body: string,
  viewport: Observation['viewport'],
  options: { readonly ambiguous: boolean },
): string {
  const indent = ' '.repeat(Math.min(depth, MAX_INDENT_DEPTH));
  const place = describePlacement(node, viewport, options.ambiguous);
  return `${indent}#${node.ref.id}${body === '' ? '' : ` ${body}`}${place}`;
}

/**
 * Where a node sits, told to the model only when it changes the answer.
 *
 * Two signals, both derived from the rect the driver already reports for every
 * node and which used to be dropped here entirely:
 *
 * - `off-screen`, with the direction, when the node is outside the viewport. The
 *   tree is document order, not reading order, so without this a control that has
 *   scrolled far above the fold reads exactly like the one in front of the user.
 *   That is not hypothetical: a booking page that opens a dialog leaves its
 *   original button at y=-2350 and renders the live one at y=491, and both
 *   serialized to the same line. The agent kept choosing the dead one, because it
 *   came first in the document, and stalled there every run.
 * - `at=x,y`, only for a line that reads identically to another one. A page with
 *   sixteen indistinguishable "check price" buttons gives the model no way to obey
 *   "the first offer"; their positions are the only thing that does. It is spent
 *   on ambiguous lines alone because on a large page it would otherwise cost
 *   thousands of bytes of the observation budget to say nothing.
 *
 * Both are advisory context for choosing between nodes. Neither is a coordinate to
 * act on: the planning and located tiers act on node references, and pixel
 * pointing has its own screenshot-derived space.
 */
function describePlacement(
  node: SemanticNode,
  viewport: Observation['viewport'],
  ambiguous: boolean,
): string {
  const rect = node.rect;
  if (rect === undefined) return '';
  const tokens: string[] = [];
  const off = offscreenDirection(rect, viewport);
  if (off !== undefined) tokens.push(`off-screen ${off}`);
  if (ambiguous) tokens.push(`at=${Math.round(rect.x)},${Math.round(rect.y)}`);
  return tokens.length === 0 ? '' : ` (${tokens.join(' ')})`;
}

/**
 * Which way a node lies outside the viewport, or undefined when any part of it is
 * inside. Vertical wins when a node is outside on both axes, because a page
 * scrolls vertically and that is the direction a reader needs.
 */
function offscreenDirection(
  rect: NonNullable<SemanticNode['rect']>,
  viewport: Observation['viewport'],
): 'above' | 'below' | 'left' | 'right' | undefined {
  if (rect.y + rect.height <= OFFSCREEN_SLACK) return 'above';
  if (rect.y >= viewport.height - OFFSCREEN_SLACK) return 'below';
  if (rect.x + rect.width <= OFFSCREEN_SLACK) return 'left';
  if (rect.x >= viewport.width - OFFSCREEN_SLACK) return 'right';
  return undefined;
}

/**
 * True when a rendered observation line carries a role token: a bare
 * lowercase word right after the node id. Role-less text holders jump
 * straight to a quoted name or `key="value"` attribute. Lives next to
 * `formatNode` so the line grammar has exactly one owner.
 */
export function observedLineHasRole(line: string): boolean {
  return /^\s*#\S+ [a-z][a-z-]*(\s|$)/.test(line);
}

/**
 * What the page looks like, independent of which observation looked at it.
 *
 * Three things are dropped. Node ids, because they are minted per observation, so
 * two looks at a page that has not moved would never render identically. The focus
 * state, because focus moves on its own — the browser settling it after load, a
 * script claiming it, a widget stealing it — without the page having changed in any
 * way a judgment could answer differently about. And placement, because it is
 * viewport-relative: scrolling, a collapsing banner, or a lazily-sized image moves
 * every coordinate on the page without changing what the page offers.
 *
 * Placement is deliberately excluded even though the model is shown it. What it
 * buys the model is a way to choose between nodes; what it would cost here is the
 * protection that stops the runner repeating a submit against a screen that has not
 * moved, since almost any pixel shift would read as a changed screen.
 *
 * Lives next to the line grammar so that grammar keeps one owner.
 */
export function observationShape(observation: AgentObservation): string {
  const stripped = observation.text
    .replaceAll(/(^|\n)(\s*)#\S+/g, '$1$2')
    .replaceAll(/ \((?:off-screen (?:above|below|left|right))?(?: ?at=-?\d+,-?\d+)?\)/g, '');
  return withoutVolatileStates(stripped);
}

function collapse(text: string): string {
  return sanitizeText(text).replace(/\s+/g, ' ').trim();
}

function indexNodes(node: SemanticNode, into: Map<string, SemanticNode>): void {
  into.set(node.ref.id, node);
  for (const child of node.children ?? []) indexNodes(child, into);
}
