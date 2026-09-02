import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, maskPng, type DecodedPng } from '../../src/png.ts';

function solid(width: number, height: number, channels: 3 | 4, value: number): DecodedPng {
  const pixels = new Uint8Array(width * height * channels).fill(value);
  if (channels === 4) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 200;
  return { width, height, channels, pixels };
}

describe('png codec', () => {
  it('round-trips RGB and RGBA samples', () => {
    for (const channels of [3, 4] as const) {
      const image = solid(5, 3, channels, 180);
      const decoded = decodePng(encodePng(image));
      expect(decoded.width).toBe(5);
      expect(decoded.height).toBe(3);
      expect(decoded.channels).toBe(channels);
      expect([...decoded.pixels]).toEqual([...image.pixels]);
    }
  });

  it('paints rects opaque black and clamps them to the image', () => {
    const masked = decodePng(maskPng(encodePng(solid(10, 10, 4, 255)), [{ x: 2, y: 2, width: 3, height: 2 }, { x: 8, y: 8, width: 50, height: 50 }]));
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
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
    const palette = Uint8Array.from(encodePng(solid(2, 2, 3, 9)));
    palette[8 + 8 + 9] = 3;
    expect(() => decodePng(palette)).toThrow(/unsupported PNG/);
  });
});
