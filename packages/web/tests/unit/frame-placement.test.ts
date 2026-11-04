import { describe, expect, it } from 'vitest';
import { placeBoxInFrame } from '../../src/observation.ts';

const FRAME = { x: 40, y: 30, width: 300, height: 150 };

describe('placeBoxInFrame', () => {
  it('shifts a box inside the frame, with no origin when its corner is its own', () => {
    expect(placeBoxInFrame({ x: 10, y: 20, width: 50, height: 40 }, undefined, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
    });
  });

  it('shifts a bordered node origin with its box', () => {
    expect(placeBoxInFrame({ x: 10, y: 20, width: 50, height: 40 }, { x: 18, y: 28 }, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
      origin: { x: 58, y: 58 },
    });
  });

  it('keeps the unclipped corner as the origin of a box the frame clips', () => {
    expect(placeBoxInFrame({ x: 0, y: -125, width: 200, height: 400 }, undefined, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 40, y: -95 },
    });
  });

  it('keeps a bordered origin unclipped when the frame clips the box', () => {
    expect(placeBoxInFrame({ x: 0, y: -125, width: 200, height: 400 }, { x: 1, y: -124 }, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 41, y: -94 },
    });
  });

  it('drops the box and origin of a node outside the frame', () => {
    expect(placeBoxInFrame({ x: 0, y: 400, width: 20, height: 20 }, { x: 1, y: 401 }, FRAME)).toEqual({});
  });
});
