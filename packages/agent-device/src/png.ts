/**
 * Minimal PNG codec for masking secure regions in device screenshots: 8-bit
 * RGB or RGBA, non-interlaced, which is what a simulator or emulator
 * screenshot is. Anything else is refused loudly, and the caller withholds
 * the image rather than shipping pixels it could not redact.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import type { Rect } from './support.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** 3 for RGB, 4 for RGBA. */
  readonly channels: number;
  /** Row-major samples, `width * channels` per row, mutable. */
  readonly pixels: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes PNG bytes into mutable samples; throws for formats this codec does not read. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.byteLength < 8 || !SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.byteLength) {
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
  if (channels === 0) throw new Error('PNG without IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? new Uint8Array(stride) : pixels.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? (out[i - channels] as number) : 0;
      const up = prior[i] as number;
      const upLeft = i >= channels ? (prior[i - channels] as number) : 0;
      const value = row[i] as number;
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
  return { width, height, channels, pixels };
}

const CRC_TABLE = new Uint32Array(256).map((_value, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  const typed = new Uint8Array(4 + data.byteLength);
  typed.set([...type].map((char) => char.charCodeAt(0)), 0);
  typed.set(data, 4);
  out.set(typed, 4);
  view.setUint32(8 + data.byteLength, crc32(typed));
  return out;
}

/** Encodes samples as a PNG with unfiltered rows; size is not the goal, fidelity is. */
export function encodePng(image: DecodedPng): Uint8Array {
  const { width, height, channels, pixels } = image;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * Paints every rect opaque black, in image pixels. Rects are clamped to the
 * image; a rect entirely outside it masks nothing but still counts as
 * handled, because the field it covers is not on screen either.
 */
function maskRects(image: DecodedPng, rects: readonly Rect[]): void {
  const { width, height, channels, pixels } = image;
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * channels;
        pixels[at] = 0;
        pixels[at + 1] = 0;
        pixels[at + 2] = 0;
        if (channels === 4) pixels[at + 3] = 255;
      }
    }
  }
}

/** Decodes, masks, and re-encodes in one step. */
export function maskPng(bytes: Uint8Array, rects: readonly Rect[]): Uint8Array {
  if (rects.length === 0) return bytes;
  const image = decodePng(bytes);
  maskRects(image, rects);
  return encodePng(image);
}
