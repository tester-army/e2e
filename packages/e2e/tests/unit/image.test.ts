/** The in-memory image operations `toHaveScreenshot` is built on: clipping, cropping, painting, the PNG round trip, and the comparison's tolerance. */

import { crc32, deflateSync } from 'node:zlib';
import { Transformer } from '@napi-rs/image';
import { describe, expect, it } from 'vitest';
import { clipBox, compareImages, cropImage, decodePng, encodePng, fillBoxes, resampleImage, type RgbaImage } from '../../src/internal/image.ts';

/** A width by height image of one gray level. */
function gray(width: number, height: number, level: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set([level, level, level, 255], at);
  return { width, height, data };
}

const exact = { threshold: 0, maxDiffPixels: undefined, maxDiffPixelRatio: undefined };

/** One PNG chunk: its length, type, data, and the CRC of type and data. */
function chunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Samples as 16-bit big-endian bytes, the order a PNG stores them in. */
function sixteen(...samples: number[]): number[] {
  return samples.flatMap((sample) => [sample >> 8, sample & 255]);
}

/**
 * A PNG written straight from the format: `rows` hold each scanline's sample
 * bytes, packed as the color type and `depth` say, with no filter. It does
 * not go through the library under test, so it can say what an encoder never would.
 */
function png(spec: {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  rows: readonly (readonly number[])[];
  palette?: readonly (readonly number[])[];
  transparency?: readonly number[];
}): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(spec.width, 0);
  header.writeUInt32BE(spec.height, 4);
  header[8] = spec.depth;
  header[9] = spec.colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(spec.palette === undefined ? [] : [chunk('PLTE', Buffer.from(spec.palette.flat()))]),
    ...(spec.transparency === undefined ? [] : [chunk('tRNS', Buffer.from(spec.transparency))]),
    chunk('IDAT', deflateSync(Buffer.concat(spec.rows.map((row) => Buffer.from([0, ...row]))))),
    chunk('IEND'),
  ]);
}

/** Red, green, and blue: the palette the indexed cases share. */
const PALETTE = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

describe('image', () => {
  it('round-trips through PNG', () => {
    const image = gray(3, 2, 120);
    expect(decodePng(encodePng(image))).toEqual(image);
  });

  it.each([
    ['gray', png({ width: 3, height: 2, depth: 8, colorType: 0, rows: [[0, 90, 180], [255, 30, 60]] }), [
      0, 0, 0, 255, 90, 90, 90, 255, 180, 180, 180, 255,
      255, 255, 255, 255, 30, 30, 30, 255, 60, 60, 60, 255,
    ]],
    ['gray with alpha', png({ width: 3, height: 2, depth: 8, colorType: 4, rows: [[0, 255, 90, 128, 180, 0], [255, 255, 30, 10, 60, 200]] }), [
      0, 0, 0, 255, 90, 90, 90, 128, 180, 180, 180, 0,
      255, 255, 255, 255, 30, 30, 30, 10, 60, 60, 60, 200,
    ]],
    ['RGB', png({ width: 3, height: 2, depth: 8, colorType: 2, rows: [[255, 0, 0, 0, 255, 0, 0, 0, 255], [10, 20, 30, 40, 50, 60, 70, 80, 90]] }), [
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
    ]],
    ['RGBA', png({ width: 3, height: 2, depth: 8, colorType: 6, rows: [[255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]] }), [
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]],
    ['16-bit gray', png({ width: 3, height: 2, depth: 16, colorType: 0, rows: [sixteen(0, 32768, 65535), sixteen(1, 257, 60000)] }), [
      0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255,
      0, 0, 0, 255, 1, 1, 1, 255, 233, 233, 233, 255,
    ]],
    ['16-bit RGBA', png({
      width: 3, height: 2, depth: 16, colorType: 6,
      rows: [sixteen(65535, 0, 0, 65535, 0, 32768, 0, 65535, 0, 0, 65535, 0), sixteen(4096, 8192, 12288, 65535, 1, 2, 3, 4, 60000, 50000, 40000, 30000)],
    }), [
      255, 0, 0, 255, 0, 128, 0, 255, 0, 0, 255, 0,
      16, 32, 48, 255, 0, 0, 0, 0, 233, 195, 156, 117,
    ]],
    ['a palette', png({ width: 3, height: 2, depth: 8, colorType: 3, palette: PALETTE, rows: [[0, 1, 2], [1, 0, 2]] }), [
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
    ]],
    ['a palette with alpha', png({ width: 3, height: 2, depth: 8, colorType: 3, palette: PALETTE, transparency: [255, 128, 0], rows: [[0, 1, 2], [1, 0, 2]] }), [
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
      0, 255, 0, 128, 255, 0, 0, 255, 0, 0, 255, 0,
    ]],
    ['a 2-bit palette', png({ width: 3, height: 2, depth: 2, colorType: 3, palette: PALETTE, rows: [[0b00_01_10_00], [0b01_00_10_00]] }), [
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
    ]],
    ['1-bit gray', png({ width: 3, height: 2, depth: 1, colorType: 0, rows: [[0b010_00000], [0b101_00000]] }), [
      0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255,
      255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]],
    ['4-bit gray', png({ width: 3, height: 2, depth: 4, colorType: 0, rows: [[0x0f, 0x80], [0x37, 0x00]] }), [
      0, 0, 0, 255, 255, 255, 255, 255, 136, 136, 136, 255,
      51, 51, 51, 255, 119, 119, 119, 255, 0, 0, 0, 255,
    ]],
    ['gray with a transparent color', png({ width: 3, height: 2, depth: 8, colorType: 0, transparency: [0, 90], rows: [[0, 90, 180], [255, 90, 60]] }), [
      0, 0, 0, 255, 90, 90, 90, 0, 180, 180, 180, 255,
      255, 255, 255, 255, 90, 90, 90, 0, 60, 60, 60, 255,
    ]],
    ['RGB with a transparent color', png({ width: 3, height: 2, depth: 8, colorType: 2, transparency: [0, 0, 0, 255, 0, 0], rows: [[255, 0, 0, 0, 255, 0, 0, 0, 255], [10, 20, 30, 0, 255, 0, 70, 80, 90]] }), [
      255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255,
      10, 20, 30, 255, 0, 255, 0, 0, 70, 80, 90, 255,
    ]],
    // Samples chosen where scaling 16 bits to 8 rounds both ways: 128 and 255 down, 129 and 32768 up.
    ['16-bit RGB', png({
      width: 3, height: 2, depth: 16, colorType: 2,
      rows: [sixteen(0, 65535, 32768, 257, 128, 129, 1000, 40000, 65000), sixteen(65535, 0, 0, 12345, 54321, 22222, 255, 256, 65534)],
    }), [
      0, 255, 128, 255, 1, 0, 1, 255, 4, 156, 253, 255,
      255, 0, 0, 255, 48, 211, 86, 255, 1, 1, 255, 255,
    ]],
    ['16-bit gray with alpha', png({
      width: 3, height: 2, depth: 16, colorType: 4,
      rows: [sixteen(0, 65535, 32768, 32768, 65535, 0), sixteen(1000, 129, 257, 128, 40000, 65000)],
    }), [
      0, 0, 0, 255, 128, 128, 128, 128, 255, 255, 255, 0,
      4, 4, 4, 1, 1, 1, 1, 0, 156, 156, 156, 253,
    ]],
    // Every sample here scales to 0 at 8 bits, so only the 16-bit comparison tells (1, 2, 3) from the colors beside it.
    ['16-bit RGB with a transparent color', png({
      width: 3, height: 2, depth: 16, colorType: 2, transparency: sixteen(1, 2, 3),
      rows: [sixteen(1, 2, 3, 4, 5, 6, 7, 8, 9), sixteen(1, 2, 3, 1, 2, 4, 9, 9, 9)],
    }), [
      0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255,
      0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255,
    ]],
  ] as const)('decodes %s to 8-bit RGBA', (_label, bytes, rgba) => {
    const decoded = decodePng(bytes);
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect([...decoded.data]).toEqual(rgba);
  });

  it('keeps every sample of an odd-sized 8-bit RGB image when it adds the alpha channel', () => {
    const width = 37;
    const height = 11;
    const samples = Array.from({ length: width * height * 3 }, (_, at) => (at * 2654435761) >>> 24);
    const rows = Array.from({ length: height }, (_, y) => samples.slice(y * width * 3, (y + 1) * width * 3));
    const expected = Array.from({ length: width * height }, (_, pixel) => [...samples.slice(pixel * 3, pixel * 3 + 3), 255]).flat();
    const decoded = decodePng(png({ width, height, depth: 8, colorType: 2, rows }));
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect([...decoded.data]).toEqual(expected);
  });

  it('encodes 8-bit RGBA PNG and returns decoded pixels a painted copy does not share', () => {
    const encoded = encodePng(gray(4, 4, 0));
    expect([encoded[24], encoded[25]]).toEqual([8, 6]);
    const decoded = decodePng(encoded);
    const painted = fillBoxes(decoded, [{ x: 0, y: 0, width: 2, height: 2 }], [255, 0, 0]);
    expect([...painted.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...decoded.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it('throws on bytes that are not a PNG, a PNG cut short, or one with a corrupt chunk', () => {
    const valid = png({ width: 2, height: 2, depth: 8, colorType: 2, rows: [[9, 9, 9, 9, 9, 9], [9, 9, 9, 9, 9, 9]] });
    const corrupt = Uint8Array.from(valid);
    corrupt[20] = 255;
    const jpeg = new Uint8Array(Transformer.fromRgbaPixels(new Uint8Array(16).fill(255), 2, 2).jpegSync());
    for (const bytes of [new Uint8Array(), new Uint8Array([1, 2, 3]), valid.subarray(0, valid.length - 10), valid.subarray(0, 40), corrupt, jpeg]) {
      expect(() => decodePng(bytes)).toThrow();
    }
    expect(() => decodePng(jpeg)).toThrow('not a PNG');
  });

  it('refuses pixels that do not fill the image, where the addon would abort the process', () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(17) })).toThrow('not 17');
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(15) })).toThrow('not 15');
  });

  it('clips a box to the image on whole pixels, and has none for a box outside it', () => {
    expect(clipBox({ width: 10, height: 10 }, { x: -2.4, y: 3.6, width: 5, height: 20 })).toEqual({ x: 0, y: 4, width: 3, height: 6 });
    expect(clipBox({ width: 10, height: 10 }, { x: 12, y: 0, width: 5, height: 5 })).toBeUndefined();
  });

  it('crops the pixels of a box and paints boxes clipped to the image', () => {
    const blank = gray(4, 4, 0);
    const image = fillBoxes(blank, [{ x: 2, y: 2, width: 10, height: 10 }], [255, 0, 0]);
    expect(blank).toEqual(gray(4, 4, 0));
    expect([...cropImage(image, { x: 1, y: 1, width: 2, height: 2 }).data]).toEqual([
      0, 0, 0, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 255, 0, 0, 255,
    ]);
  });

  it('averages the pixels each target pixel covers when it resamples', () => {
    const image: RgbaImage = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 200, 200, 200, 255]) };
    expect([...resampleImage(image, 1, 1).data]).toEqual([100, 100, 100, 255]);
    expect(resampleImage(image, 2, 1)).toBe(image);
  });

  it('reports a size mismatch, and counts differing pixels against maxDiffPixels and maxDiffPixelRatio, the smaller one when both are set', () => {
    expect(compareImages(gray(2, 2, 0), gray(2, 3, 0), exact)).toMatchObject({ kind: 'size' });
    const expected = gray(10, 10, 255);
    const actual = fillBoxes(gray(10, 10, 255), [{ x: 0, y: 0, width: 5, height: 1 }], [0, 0, 0]);
    expect(compareImages(expected, actual, exact)).toMatchObject({ kind: 'pixels', diffPixels: 5, ratio: 0.05 });
    expect(compareImages(expected, actual, { ...exact, maxDiffPixels: 5 })).toMatchObject({ kind: 'match' });
    expect(compareImages(expected, actual, { ...exact, maxDiffPixelRatio: 0.05 })).toMatchObject({ kind: 'match' });
    expect(compareImages(expected, actual, { ...exact, maxDiffPixels: 10, maxDiffPixelRatio: 0.04 })).toMatchObject({ kind: 'pixels' });
  });

  it('counts a pixel as the same when its color is within the threshold', () => {
    expect(compareImages(gray(4, 4, 200), gray(4, 4, 204), { ...exact, threshold: 0.2 })).toMatchObject({ kind: 'match' });
    expect(compareImages(gray(4, 4, 200), gray(4, 4, 204), exact)).toMatchObject({ kind: 'pixels', diffPixels: 16 });
  });
});
