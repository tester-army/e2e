import { describe, expect, it } from 'vitest';
import { maskPng } from '../../src/png.ts';
import { decodePng, encodePng, type DecodedPng } from '../helpers/png.ts';

function solid(width: number, height: number, channels: 3 | 4, value: number): DecodedPng {
  const pixels = new Uint8Array(width * height * channels).fill(value);
  if (channels === 4) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 200;
  return { width, height, channels, pixels };
}

describe('screenshot masking', () => {
  it.each([0, 1, 2, 3, 4])('masks and clips RGBA screenshots encoded with filter %i', (filter) => {
    const masked = decodePng(maskPng(encodePng(solid(10, 10, 4, 255), filter), [{ x: 2, y: 2, width: 3, height: 2 }, { x: 8, y: 8, width: 50, height: 50 }]));
    const at = (x: number, y: number) => [...masked.pixels.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4)];
    expect(at(2, 2)).toEqual([0, 0, 0, 255]);
    expect(at(4, 3)).toEqual([0, 0, 0, 255]);
    expect(at(5, 3)).toEqual([255, 255, 255, 200]);
    expect(at(1, 2)).toEqual([255, 255, 255, 200]);
    expect(at(9, 9)).toEqual([0, 0, 0, 255]);
    expect(at(7, 7)).toEqual([255, 255, 255, 200]);
  });

  it('returns the bytes untouched when there is nothing to mask, and refuses other formats', () => {
    const bytes = encodePng(solid(2, 2, 3, 9));
    expect(maskPng(bytes, [])).toBe(bytes);
    const rects = [{ x: 0, y: 0, width: 1, height: 1 }];
    expect(() => maskPng(new Uint8Array([1, 2, 3]), rects)).toThrow();
    expect(() => maskPng(bytes.slice(0, -10), rects)).toThrow();
    const corrupt = Uint8Array.from(bytes);
    corrupt[20] = 255;
    expect(() => maskPng(corrupt, rects)).toThrow();
    const masked = decodePng(maskPng(bytes, rects));
    expect([...masked.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...masked.pixels.subarray(4, 8)]).toEqual([9, 9, 9, 255]);
  });
});
