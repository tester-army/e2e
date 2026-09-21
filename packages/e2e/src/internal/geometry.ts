/** Point and box arithmetic shared by the pixel tier, the point tap, and target relocation. */

import type { SemanticNode, ViewportPoint, ViewportSize } from '../engine/contract.ts';
import { TestError } from './errors.ts';

/** A node's box, in the viewport's CSS pixels. */
export type Box = NonNullable<SemanticNode['rect']>;

/**
 * Validates a point as two finite numbers and returns a plain copy; anything
 * else is `INVALID_ARGUMENT` naming `what` asked for it. Callers layer their
 * own rule on top: the agent clamps into the viewport, a test refuses negatives.
 */
export function requireFinitePoint(point: unknown, what: string): ViewportPoint {
  const x = (point as { x?: unknown } | undefined)?.x;
  const y = (point as { y?: unknown } | undefined)?.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TestError('INVALID_ARGUMENT', `${what} requires a point { x, y } of finite numbers`);
  }
  return { x, y };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Rounds a point to whole CSS pixels and keeps it inside a box of the given
 * size, so a point placed off the edge lands on the edge rather than failing
 * the engine.
 */
export function clampToViewport(
  point: ViewportPoint,
  viewport: ViewportSize,
): ViewportPoint {
  return {
    x: clamp(Math.round(point.x), 0, Math.max(0, viewport.width - 1)),
    y: clamp(Math.round(point.y), 0, Math.max(0, viewport.height - 1)),
  };
}

/** True when the point lies inside the box: on its top and left edges, short of its bottom and right ones. */
export function containsPoint(box: Box, point: ViewportPoint): boolean {
  return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
}

/**
 * How much two boxes are the same box: the area they share over the area
 * either covers, 0 for boxes apart and 1 for the same box.
 */
export function overlapShare(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  const union = a.width * a.height + b.width * b.height - shared;
  return union <= 0 ? 0 : shared / union;
}

/**
 * The share of a viewport a box covers, 0 to 1: only the part of the box
 * inside the viewport counts, so a tall list mostly below the fold is not
 * the main list. 0 for a viewport without area.
 */
export function viewportShare(box: Box, viewport: ViewportSize): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 0;
  const width = Math.min(box.x + box.width, viewport.width) - Math.max(box.x, 0);
  const height = Math.min(box.y + box.height, viewport.height) - Math.max(box.y, 0);
  if (width <= 0 || height <= 0) return 0;
  return clamp((width * height) / (viewport.width * viewport.height), 0, 1);
}
