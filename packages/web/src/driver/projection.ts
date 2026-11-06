/**
 * Projective maps of the plane, which carry a point from a frame's document
 * to the one around it through any transform the frame shows: a scale, a
 * rotation, or a 3D transform flattened onto the screen.
 */

/** A point in CSS pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A 3x3 matrix in row order, `[a, b, c, d, e, f, g, h, i]`, which maps
 * (x, y) to ((a x + b y + c) / w, (d x + e y + f) / w) with w = g x + h y + i.
 */
export type Projection = readonly [number, number, number, number, number, number, number, number, number];

/** The map that leaves every point where it is. */
export const IDENTITY: Projection = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The map that scales by `scale` about the origin, then moves the origin to `origin`. */
export function scaleThenTranslate(origin: Point, scale: Point): Projection {
  return [scale.x, 0, origin.x, 0, scale.y, origin.y, 0, 0, 1];
}

/** Where `map` takes `point`. */
export function project(map: Projection, point: Point): Point {
  const [a, b, c, d, e, f, g, h, i] = map;
  const w = g * point.x + h * point.y + i;
  return { x: (a * point.x + b * point.y + c) / w, y: (d * point.x + e * point.y + f) / w };
}

/** `outer` after `inner`: the map that applies `inner`, then `outer`. */
export function compose(outer: Projection, inner: Projection): Projection {
  const at = (row: number, column: number): number => outer[row * 3]! * inner[column]! + outer[row * 3 + 1]! * inner[3 + column]! + outer[row * 3 + 2]! * inner[6 + column]!;
  return [at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(1, 2), at(2, 0), at(2, 1), at(2, 2)];
}

/** The map that undoes `map`; undefined when it flattens the plane onto a line. */
export function invert(map: Projection): Projection | undefined {
  const [a, b, c, d, e, f, g, h, i] = map;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (Math.abs(determinant) < 1e-12) return undefined;
  const k = 1 / determinant;
  return [A * k, (c * h - b * i) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, (c * d - a * f) * k, C * k, (b * g - a * h) * k, (a * e - b * d) * k];
}

/**
 * The map that takes the rect from (0, 0) to (`width`, `height`) onto
 * `quad`, its corners in order top-left, top-right, bottom-right,
 * bottom-left; undefined when the rect is empty or the quad is degenerate.
 */
export function rectToQuad(width: number, height: number, quad: readonly [Point, Point, Point, Point]): Projection | undefined {
  if (width <= 0 || height <= 0) return undefined;
  const [p0, p1, p2, p3] = quad;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 1e-12) return undefined;
  const g = (sx * dy2 - dx2 * sy) / denominator;
  const h = (dx1 * sy - sx * dy1) / denominator;
  const unitSquare: Projection = [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
  return compose(unitSquare, [1 / width, 0, 0, 0, 1 / height, 0, 0, 0, 1]);
}
