/** Point arithmetic shared by the pixel tier and the point tap. */

import type { ViewportPoint } from '../engine/contract.ts';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Rounds a point to whole CSS pixels and keeps it inside a box of the given
 * size, so a point placed off the edge lands on the edge rather than failing
 * the engine. A missing size only rounds.
 */
export function clampToViewport(
  point: ViewportPoint,
  viewport: { readonly width: number; readonly height: number } | undefined,
): ViewportPoint {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (viewport === undefined) return { x, y };
  return {
    x: clamp(x, 0, Math.max(0, viewport.width - 1)),
    y: clamp(y, 0, Math.max(0, viewport.height - 1)),
  };
}
