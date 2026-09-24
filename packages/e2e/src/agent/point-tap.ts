/**
 * Point taps: how a viewport point an executor names is routed onto the
 * tree, and how the result reads back. A point that a listed, enabled
 * control contains is tapped by that control's id, so policy, stale
 * relocation, and the trace cache see an ordinary tap; a point on nothing
 * listed goes to the engine as a bare point. Coordinates read off a
 * screenshot are scaled into the observation's CSS pixels first.
 */

import type { PointActionName } from '../cache/trace.ts';
import type { SemanticNode, ViewportPoint, ViewportSize } from '../engine/surface.ts';
import { clamp, clampToViewport, containsPoint } from '../internal/geometry.ts';
import type { ExecutorPixels } from './executor.ts';
import { INTERACTIVE_ROLES, type AgentObservation, type SemanticAgentObservation } from './observation.ts';

/**
 * Scales a point read off a screenshot into the observation's CSS pixels and
 * clamps it to the viewport. `pixels.scale` is image pixels per CSS pixel
 * (3 on a device screenshot, 1 on a CSS-scale capture); the observation's
 * own `viewport.scale` is not consulted, because a device engine reports its
 * geometry in logical points regardless of the image.
 */
export function imagePointToViewport(
  point: { readonly x: number; readonly y: number },
  pixels: Pick<ExecutorPixels, 'width' | 'height' | 'scale'>,
  viewport: ViewportSize,
): ViewportPoint {
  const scale = pixels.scale > 0 ? pixels.scale : 1;
  return clampToViewport(
    {
      x: clamp(point.x, 0, Math.max(0, pixels.width - 1)) / scale,
      y: clamp(point.y, 0, Math.max(0, pixels.height - 1)) / scale,
    },
    viewport,
  );
}

export interface HitTest {
  /** The innermost enabled control whose box contains the point, if any. */
  readonly control: SemanticNode | undefined;
  /** The innermost listed node of any role whose box contains the point, if any. */
  readonly under: SemanticNode | undefined;
}

/**
 * Finds what the newest observation lists at a viewport point. Only an
 * enabled interactive role counts as the control: tapping a node taps its
 * center, which is what the caller asked for only when the node is the
 * control itself, not a paragraph or region that happens to contain the
 * point.
 */
export function hitTest(observation: AgentObservation, point: ViewportPoint): HitTest {
  if (observation.kind === 'pixels') return { control: undefined, under: undefined };
  return {
    control: innermostAt(observation, point, (node) => INTERACTIVE_ROLES.has(node.role ?? '') && node.states?.disabled !== true),
    under: innermostAt(observation, point),
  };
}

/**
 * The innermost listed node whose box contains the point, among those
 * `accept` admits: deepest in the tree, then the smallest box. Hidden nodes
 * and nodes without a box are skipped. Every box is in the top-level
 * viewport's CSS pixels, nested documents included (`SemanticNode.rect`), so
 * a node inside an iframe is found like any other.
 */
function innermostAt(
  observation: SemanticAgentObservation,
  point: ViewportPoint,
  accept: (node: SemanticNode) => boolean = () => true,
): SemanticNode | undefined {
  let best: { node: SemanticNode; depth: number; area: number } | undefined;
  for (const node of observation.nodes.values()) {
    const rect = node.rect;
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) continue;
    if (node.states?.hidden === true || !containsPoint(rect, point) || !accept(node)) continue;
    const candidate = { node, depth: depthOf(node.ref.id, observation.parents), area: rect.width * rect.height };
    if (inner(candidate, best)) best = candidate;
  }
  return best?.node;
}

function inner(
  candidate: { depth: number; area: number },
  best: { depth: number; area: number } | undefined,
): boolean {
  if (best === undefined) return true;
  if (candidate.depth !== best.depth) return candidate.depth > best.depth;
  return candidate.area < best.area;
}

function depthOf(id: string, parents: ReadonlyMap<string, string>): number {
  let depth = 0;
  for (let cursor = parents.get(id); cursor !== undefined; cursor = parents.get(cursor)) depth += 1;
  return depth;
}

/** The observation's own line for a node, as the model already reads it; the id alone when the line was cut. */
export function nodeLine(observation: Pick<AgentObservation, 'text'>, id: string): string {
  for (const line of observation.text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(`#${id} `) || trimmed === `#${id}`) return trimmed;
  }
  return `#${id}`;
}

/** How a point result names what it found: by the observation's own line, which the model holds. */
export interface PointProse {
  readonly observation: Pick<AgentObservation, 'text'>;
}

/**
 * The point verbs: the node verb each resolves onto when a listed control
 * sits under the point, and how each reads back to the model. The one place
 * the pairing lives; the tools, the dispatcher, and the prose read it.
 */
export const POINT_VERBS: Readonly<Record<PointActionName, { readonly node: 'tap' | 'hover'; readonly did: string }>> = {
  tapAt: { node: 'tap', did: 'Tapped' },
  hoverAt: { node: 'hover', did: 'Hovered over' },
};

/** What one point action did, for the model that named the point. */
export function describePointAction(
  input: PointProse & {
    readonly verb: PointActionName;
    readonly point: ViewportPoint;
    readonly control: SemanticNode | undefined;
    readonly under: SemanticNode | undefined;
  },
): string {
  const { did } = POINT_VERBS[input.verb];
  const at = `(${String(input.point.x)}, ${String(input.point.y)})`;
  if (input.control !== undefined) {
    return `${did} ${describeNode(input, input.control)}, the control at ${at}.`;
  }
  const under = input.under === undefined ? '' : ` (under it: ${describeNode(input, input.under)})`;
  return `${did} the point ${at}; no listed control is there${under}.`;
}

/** What one hit test found, for the model that named the point. */
export function describePointHit(
  input: PointProse & {
    readonly point: ViewportPoint;
    readonly control: SemanticNode | undefined;
    readonly under: SemanticNode | undefined;
  },
): string {
  const at = `(${String(input.point.x)}, ${String(input.point.y)})`;
  if (input.control !== undefined) return `${describeNode(input, input.control)}, the control at ${at}`;
  if (input.under !== undefined) return `no control is listed at ${at}; under it: ${describeNode(input, input.under)}`;
  return `nothing the screen lists is at ${at}`;
}

/** A node as prose: its observation line, which the model holds. */
function describeNode(prose: PointProse, node: SemanticNode): string {
  return nodeLine(prose.observation, node.ref.id);
}
