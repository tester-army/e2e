/** Point and box arithmetic shared by the pixel tier, the point tap, and target relocation. */

import type { SemanticNode, ViewportPoint, ViewportSize } from '../engine/contract.ts';

/** A node's box, in the viewport's CSS pixels. */
export type Box = NonNullable<SemanticNode['rect']>;

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

/** The share of a viewport a box covers, 0 to 1; 0 for a viewport without area. */
export function viewportShare(box: Box, viewport: ViewportSize): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 0;
  return clamp((box.width * box.height) / (viewport.width * viewport.height), 0, 1);
}
