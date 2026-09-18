import { describe, expect, it } from 'vitest';
import { overlapShare, viewportShare } from '../../src/internal/geometry.ts';

const viewport = { width: 400, height: 800 };

describe('viewportShare', () => {
  it('counts only the part of the box inside the viewport', () => {
    expect(viewportShare({ x: 0, y: 0, width: 400, height: 800 }, viewport)).toBe(1);
    expect(viewportShare({ x: 0, y: 700, width: 400, height: 500 }, viewport)).toBeCloseTo(0.125);
    expect(viewportShare({ x: -200, y: 0, width: 400, height: 800 }, viewport)).toBe(0.5);
    expect(viewportShare({ x: 0, y: 900, width: 400, height: 500 }, viewport)).toBe(0);
    expect(viewportShare({ x: 0, y: 0, width: 400, height: 800 }, { width: 0, height: 800 })).toBe(0);
  });
});

describe('overlapShare', () => {
  it('is the shared area over the union, 1 for the same box and 0 for boxes apart', () => {
    const box = { x: 0, y: 96, width: 402, height: 778 };
    expect(overlapShare(box, box)).toBe(1);
    expect(overlapShare(box, { x: 0, y: 300, width: 402, height: 160 })).toBeCloseTo(160 / 778);
    expect(overlapShare(box, { x: 0, y: 900, width: 402, height: 100 })).toBe(0);
  });
});
