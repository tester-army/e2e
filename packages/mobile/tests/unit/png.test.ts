import { FilterType, Transformer } from '@napi-rs/image';
import { describe, expect, it } from 'vitest';
import { maskPng } from '../../src/png.ts';
import { decodePng, encodePng, rawPng, type DecodedPng } from '../helpers/png.ts';

function solid(width: number, height: number, channels: 3 | 4, value: number): DecodedPng {
  const pixels = new Uint8Array(width * height * channels).fill(value);
  if (channels === 4) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 200;
  return { width, height, channels, pixels };
}

describe('screenshot masking', () => {
  it.each([FilterType.NoFilter, FilterType.Paeth])('masks and clips RGBA screenshots encoded with filter %i', (filter) => {
    const masked = decodePng(maskPng(encodePng(solid(10, 10, 4, 255), filter), [{ x: 2, y: 2, width: 3, height: 2 }, { x: 8, y: 8, width: 50, height: 50 }]));
    const at = (x: number, y: number) => [...masked.pixels.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4)];
    expect(at(2, 2)).toEqual([0, 0, 0, 255]);
    expect(at(4, 3)).toEqual([0, 0, 0, 255]);
    expect(at(5, 3)).toEqual([255, 255, 255, 200]);
    expect(at(1, 2)).toEqual([255, 255, 255, 200]);
    expect(at(9, 9)).toEqual([0, 0, 0, 255]);
    expect(at(7, 7)).toEqual([255, 255, 255, 200]);
  });

  /** A 4 by 4 screenshot whose every pixel has the same `samples`, as the color type and bit depth pack them. */
  function filled(depth: number, colorType: number, samples: readonly number[]): Uint8Array {
    const row = Array.from({ length: 4 }, () => samples).flat();
    return rawPng(4, 4, depth, colorType, Array.from({ length: 4 }, () => row));
  }

  it.each([
    ['gray', filled(8, 0, [200]), [200, 200, 200, 255]],
    ['gray with alpha', filled(8, 4, [200, 128]), [200, 200, 200, 128]],
    ['RGB', filled(8, 2, [10, 20, 30]), [10, 20, 30, 255]],
    ['16-bit RGB', filled(16, 2, [255, 255, 128, 0, 1, 1]), [255, 128, 1, 255]],
    ['16-bit RGBA', filled(16, 6, [0, 0, 255, 255, 0, 0, 128, 0]), [0, 255, 0, 128]],
  ] as const)('masks a %s screenshot and writes the rest of it as RGBA', (_label, bytes, color) => {
    const masked = decodePng(maskPng(bytes, [{ x: 0, y: 0, width: 2, height: 2 }]));
    const at = (x: number, y: number) => [...masked.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(at(0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(1, 1)).toEqual([0, 0, 0, 255]);
    expect(at(2, 0)).toEqual(color);
    expect(at(3, 3)).toEqual(color);
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
    const jpeg = new Uint8Array(Transformer.fromRgbaPixels(new Uint8Array(16).fill(255), 2, 2).jpegSync());
    expect(() => maskPng(jpeg, rects)).toThrow('not a PNG');
    const masked = decodePng(maskPng(bytes, rects));
    expect([...masked.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...masked.pixels.subarray(4, 8)]).toEqual([9, 9, 9, 255]);
  });
});
