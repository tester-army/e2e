/** Projective maps of the plane: a rect onto any quad, their composition, and their inverse. */

import { describe, expect, it } from 'vitest';
import { compose, IDENTITY, invert, project, rectToQuad, scaleThenTranslate, type Point } from '../../src/bidi/projection.ts';

/** `point` with its coordinates rounded to 6 places, so float noise does not fail a comparison. */
function rounded(point: Point): Point {
  return { x: Math.round(point.x * 1e6) / 1e6, y: Math.round(point.y * 1e6) / 1e6 };
}

describe('rectToQuad', () => {
  it('takes each corner of the rect onto its corner of the quad, for a rotated and a perspective quad', () => {
    for (const quad of [
      [{ x: 10, y: 20 }, { x: 110, y: 40 }, { x: 90, y: 140 }, { x: -10, y: 120 }],
      [{ x: 0, y: 0 }, { x: 200, y: 30 }, { x: 180, y: 160 }, { x: 15, y: 100 }],
    ] as const) {
      const map = rectToQuad(40, 30, quad)!;
      expect([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }].map((corner) => rounded(project(map, corner)))).toEqual(quad);
    }
  });

  it('is a scale and a translation for an axis-aligned quad', () => {
    const map = rectToQuad(100, 50, [{ x: 10, y: 20 }, { x: 210, y: 20 }, { x: 210, y: 120 }, { x: 10, y: 120 }])!;
    expect(rounded(project(map, { x: 25, y: 10 }))).toEqual(project(scaleThenTranslate({ x: 10, y: 20 }, { x: 2, y: 2 }), { x: 25, y: 10 }));
  });

  it('refuses an empty rect and a quad flattened onto a line', () => {
    expect(rectToQuad(0, 10, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).toBeUndefined();
    expect(rectToQuad(10, 10, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }])).toBeUndefined();
  });
});

describe('compose and invert', () => {
  it('applies the inner map first, and undoes a map with its inverse', () => {
    const turn = rectToQuad(40, 30, [{ x: 10, y: 20 }, { x: 110, y: 40 }, { x: 90, y: 140 }, { x: -10, y: 120 }])!;
    const shift = scaleThenTranslate({ x: 5, y: 7 }, { x: 1, y: 1 });
    const point = { x: 12, y: 9 };
    expect(rounded(project(compose(shift, turn), point))).toEqual(rounded(project(shift, project(turn, point))));
    expect(rounded(project(invert(turn)!, project(turn, point)))).toEqual(point);
    expect(compose(IDENTITY, shift)).toEqual(shift);
    expect(invert([1, 2, 0, 2, 4, 0, 0, 0, 1])).toBeUndefined();
  });
});
