/** Screenshot masking policy: a PNG decoded with @napi-rs/image, its secure regions painted black, encoded again; the layout code turns the addon's pixels into 8-bit RGBA. */
import { endianness } from 'node:os';
import { FilterType, JsColorType, Transformer } from '@napi-rs/image';
import type { Rect } from './support.ts';

const LITTLE_ENDIAN = endianness() === 'LE';

/** Channels per pixel, and whether each is a 16-bit sample, for every color type a decode reads: 8-bit RGB is widened by the addon before that. */
const LAYOUTS: Readonly<Partial<Record<JsColorType, { readonly channels: number; readonly wide: boolean }>>> = {
  [JsColorType.L8]: { channels: 1, wide: false },
  [JsColorType.La8]: { channels: 2, wide: false },
  [JsColorType.Rgba8]: { channels: 4, wide: false },
  [JsColorType.L16]: { channels: 1, wide: true },
  [JsColorType.La16]: { channels: 2, wide: true },
  [JsColorType.Rgb16]: { channels: 3, wide: true },
  [JsColorType.Rgba16]: { channels: 4, wide: true },
};

/** An 8-bit RGBA image, rows top to bottom. */
interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Paints each requested rectangle opaque black, rounding outward and clipping to the image. */
export function maskPng(bytes: Uint8Array, rects: readonly Rect[]): Uint8Array {
  if (rects.length === 0) return bytes;
  const image = decodeRgba(bytes);
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * image.width + x) * 4;
        image.data[at] = 0;
        image.data[at + 1] = 0;
        image.data[at + 2] = 0;
        image.data[at + 3] = 255;
      }
    }
  }
  return encodeRgba(image);
}

/**
 * Decodes PNG bytes to 8-bit RGBA, whatever the color type, bit depth, or
 * palette; throws on bytes that are not a PNG. An 8-bit RGB screenshot is
 * widened by the addon: opacity 1 keeps every sample and adds the opaque
 * alpha channel, several times faster than `spread` does it.
 */
function decodeRgba(bytes: Uint8Array): Rgba {
  const decoder = new Transformer(bytes);
  const { width, height, format, colorType } = decoder.metadataSync();
  if (format !== 'png') throw new Error(`not a PNG: the bytes are ${format}`);
  const rgb = colorType === JsColorType.Rgb8;
  const raw = (rgb ? decoder.opacity(1) : decoder).rawPixelsSync();
  const layout = LAYOUTS[rgb ? JsColorType.Rgba8 : colorType];
  if (layout === undefined) throw new Error(`unsupported PNG color type ${colorType}`);
  const { channels, wide } = layout;
  if (raw.length !== width * height * channels * (wide ? 2 : 1)) throw new Error('the decoded PNG pixels do not fill its size');
  const samples = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (channels === 4 && !wide) return { width, height, data: samples };
  return { width, height, data: spread(wide ? narrow(samples) : samples, channels, width * height) };
}

/**
 * Encodes an image as PNG bytes, each row adaptively filtered: the addon's
 * default writes no filter, which makes screenshots markedly larger.
 */
function encodeRgba(image: Rgba): Uint8Array {
  const png = Transformer.fromRgbaPixels(image.data, image.width, image.height).pngSync({ filterType: FilterType.Adaptive });
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

/** 16-bit samples in native byte order as 8-bit samples, rounded. */
function narrow(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Uint8Array(bytes.length / 2);
  for (let at = 0; at < samples.length; at += 1) samples[at] = Math.round((view.getUint16(at * 2, LITTLE_ENDIAN) * 255) / 65535);
  return samples;
}

/** 8-bit samples of `channels` per pixel (gray, gray and alpha, RGB) as RGBA; a gray or RGB image is opaque. */
function spread(samples: Uint8Array, channels: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4);
  const gray = channels <= 2;
  const alpha = channels === 2 || channels === 4;
  for (let pixel = 0, from = 0, to = 0; pixel < pixels; pixel += 1, from += channels, to += 4) {
    const r = samples[from]!;
    out[to] = r;
    out[to + 1] = gray ? r : samples[from + 1]!;
    out[to + 2] = gray ? r : samples[from + 2]!;
    out[to + 3] = alpha ? samples[from + channels - 1]! : 255;
  }
  return out;
}
