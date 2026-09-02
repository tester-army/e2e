/**
 * Minimal PNG reader for pixel assertions on screenshots: 8-bit RGB/RGBA,
 * non-interlaced, which is what a browser screenshot is. Anything else is
 * refused loudly rather than misread.
 */

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA at one pixel; alpha is 255 for an RGB image. */
  pixelAt(x: number, y: number): readonly [number, number, number, number];
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes PNG bytes into a pixel reader. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG: depth ${String(bitDepth)} type ${String(colorType)}`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? new Uint8Array(stride) : pixels.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[i - channels]! : 0;
      const up = prior[i]!;
      const upLeft = i >= channels ? prior[i - channels]! : 0;
      const value = row[i]!;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = Math.floor((left + up) / 2);
          break;
        case 4:
          predicted = paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${String(filter)}`);
      }
      out[i] = (value + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    pixelAt(x, y) {
      const at = y * stride + x * channels;
      return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!, channels === 4 ? pixels[at + 3]! : 255];
    },
  };
}
