/** RGBA images in memory: PNG decoding and encoding, resampling, cropping, painting boxes, and comparing two images. */

import { createRequire } from 'node:module';
import { endianness } from 'node:os';
import type * as NapiImage from '@napi-rs/image';
import pixelmatch from 'pixelmatch';
import { InfrastructureError } from './errors.ts';

const ownRequire = createRequire(import.meta.url);

/** An RGBA image, 8 bits per channel, rows top to bottom. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A box in image pixels. */
export interface ImageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const LITTLE_ENDIAN = endianness() === 'LE';

/** `@napi-rs/image`, loaded on the first PNG decoded or encoded. */
let addon: typeof NapiImage | undefined;

/**
 * `@napi-rs/image`, loaded when the first PNG is decoded or encoded rather
 * than when e2e loads, so a command or a test that touches no screenshot
 * (`--version`, `--help`, `doctor`) still runs without its native binding.
 * npm leaves that binding out with `--omit=optional`, and from a lockfile
 * written on another platform (npm/cli#4828); the package publishes none for
 * Linux on ppc64, s390x, or riscv64. The error names the binding and the
 * way back.
 */
function napi(): typeof NapiImage {
  if (addon !== undefined) return addon;
  try {
    addon = ownRequire('@napi-rs/image') as typeof NapiImage;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const platform = `${process.platform}-${process.arch}`;
    // napi-rs's loader says so when no platform package is installed.
    const fix = message.includes('Cannot find native binding')
      ? `its native binding for ${platform} (@napi-rs/image-${platform}*) is not installed. npm skips it with --omit=optional, or when package-lock.json was written on another platform (npm/cli#4828): install again without --omit=optional, or delete package-lock.json and node_modules and run npm install. The package has no binding for Linux on ppc64, s390x, or riscv64`
      : `it could not be loaded (${message.split('\n', 1)[0]})`;
    throw new InfrastructureError('IMAGE_CODEC_UNAVAILABLE', `e2e reads and writes screenshots with @napi-rs/image, and ${fix}`, { cause });
  }
  return addon;
}

/** Channels per pixel, and whether each is a 16-bit sample, for every color type `toRgba` is handed: 8-bit RGB is widened by the addon before that. */
function layoutOf(colorType: NapiImage.JsColorType): { readonly channels: number; readonly wide: boolean } | undefined {
  const { JsColorType } = napi();
  switch (colorType) {
    case JsColorType.L8:
      return { channels: 1, wide: false };
    case JsColorType.La8:
      return { channels: 2, wide: false };
    case JsColorType.Rgba8:
      return { channels: 4, wide: false };
    case JsColorType.L16:
      return { channels: 1, wide: true };
    case JsColorType.La16:
      return { channels: 2, wide: true };
    case JsColorType.Rgb16:
      return { channels: 3, wide: true };
    case JsColorType.Rgba16:
      return { channels: 4, wide: true };
    default:
      return undefined;
  }
}

/**
 * Decodes PNG bytes to 8-bit RGBA: any color type, at 1 to 16 bits or with a
 * palette; throws on anything else. A Chromium capture is 8-bit RGB, and the
 * addon widens that itself: opacity 1 keeps every sample and adds the opaque
 * alpha channel, several times faster than `spread` does it.
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const { JsColorType, Transformer } = napi();
  const decoder = new Transformer(bytes);
  const { width, height, format, colorType } = decoder.metadataSync();
  if (format !== 'png') throw new Error(`not a PNG: the bytes are ${format}`);
  const rgb = colorType === JsColorType.Rgb8;
  const raw = (rgb ? decoder.opacity(1) : decoder).rawPixelsSync();
  return { width, height, data: toRgba(raw, rgb ? JsColorType.Rgba8 : colorType, width * height) };
}

/**
 * Encodes an image as PNG bytes, each row adaptively filtered: the addon's
 * default writes no filter, which makes screenshots markedly larger. The
 * addon also aborts the whole process on a pixel buffer longer than the
 * image, so a buffer of the wrong length throws here instead of reaching it.
 */
export function encodePng(image: RgbaImage): Uint8Array {
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error(`a ${image.width}x${image.height} image is ${image.width * image.height * 4} bytes of RGBA, not ${image.data.length}`);
  }
  const { FilterType, Transformer } = napi();
  return plain(Transformer.fromRgbaPixels(image.data, image.width, image.height).pngSync({ filterType: FilterType.Adaptive }));
}

/** A native buffer's bytes as a plain `Uint8Array`, whose `slice` copies where a `Buffer`'s shares memory. */
function plain(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * The decoder's pixels as 8-bit RGBA. The decoder has already expanded a
 * palette, sub-byte samples, and a transparent color, so what is left is a
 * layout: one to four channels at 8 or 16 bits, the 16-bit samples in native
 * byte order. Gray spreads to three channels, a missing alpha is opaque, and
 * 16-bit samples scale to 8 bits with rounding.
 */
function toRgba(raw: Buffer, colorType: NapiImage.JsColorType, pixels: number): Uint8Array {
  const layout = layoutOf(colorType);
  if (layout === undefined) throw new Error(`unsupported PNG color type ${colorType}`);
  const { channels, wide } = layout;
  if (raw.length !== pixels * channels * (wide ? 2 : 1)) throw new Error('the decoded PNG pixels do not fill its size');
  const bytes = plain(raw);
  if (channels === 4 && !wide) return bytes;
  return spread(wide ? narrow(bytes) : bytes, channels, pixels);
}

/** 16-bit samples in native byte order as 8-bit samples, rounded. */
function narrow(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Uint8Array(bytes.length / 2);
  for (let at = 0; at < samples.length; at += 1) samples[at] = Math.round((view.getUint16(at * 2, LITTLE_ENDIAN) * 255) / 65535);
  return samples;
}

/** 8-bit samples of `channels` per pixel (gray, gray and alpha, RGB) as RGBA. */
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

/** Resamples an image to `width` by `height` with a box filter; the input itself when it already has that size. */
export function resampleImage(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) return image;
  const data = new Uint8Array(width * height * 4);
  boxResample(image.data, image.width, image.height, data, width, height);
  return { width, height, data };
}

/** Averages, per channel, every source pixel a target pixel covers. RGBA, 8 bits per channel. */
function boxResample(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  target: Uint8Array,
  targetWidth: number,
  targetHeight: number,
): void {
  const xRatio = sourceWidth / targetWidth;
  const yRatio = sourceHeight / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor(ty * yRatio);
    const y1 = Math.min(sourceHeight, Math.max(y0 + 1, Math.floor((ty + 1) * yRatio)));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor(tx * xRatio);
      const x1 = Math.min(sourceWidth, Math.max(x0 + 1, Math.floor((tx + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        let offset = (y * sourceWidth + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          r += source[offset]!;
          g += source[offset + 1]!;
          b += source[offset + 2]!;
          a += source[offset + 3]!;
          offset += 4;
          count += 1;
        }
      }
      const at = (ty * targetWidth + tx) * 4;
      target[at] = Math.round(r / count);
      target[at + 1] = Math.round(g / count);
      target[at + 2] = Math.round(b / count);
      target[at + 3] = Math.round(a / count);
    }
  }
}

/** The part of `box` inside the image, on whole pixels; undefined when none of it is. */
export function clipBox(image: Pick<RgbaImage, 'width' | 'height'>, box: ImageBox): ImageBox | undefined {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(image.width, Math.round(box.x + box.width));
  const y1 = Math.min(image.height, Math.round(box.y + box.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

/** The pixels of a box already inside the image (see `clipBox`). */
export function cropImage(image: RgbaImage, box: ImageBox): RgbaImage {
  const data = new Uint8Array(box.width * box.height * 4);
  for (let row = 0; row < box.height; row += 1) {
    const from = ((box.y + row) * image.width + box.x) * 4;
    data.set(image.data.subarray(from, from + box.width * 4), row * box.width * 4);
  }
  return { width: box.width, height: box.height, data };
}

/** A copy of the image with each box, clipped to it, painted opaque in `color`. */
export function fillBoxes(image: RgbaImage, boxes: readonly ImageBox[], color: readonly [number, number, number]): RgbaImage {
  const data = image.data.slice();
  for (const box of boxes) {
    const clipped = clipBox(image, box);
    if (clipped === undefined) continue;
    for (let y = clipped.y; y < clipped.y + clipped.height; y += 1) {
      for (let x = clipped.x; x < clipped.x + clipped.width; x += 1) {
        data.set([color[0], color[1], color[2], 255], (y * image.width + x) * 4);
      }
    }
  }
  return { width: image.width, height: image.height, data };
}

/** How far two images may differ and still match. */
export interface ImageTolerance {
  /** Per-pixel color distance, 0 to 1, below which two pixels are the same. */
  readonly threshold: number;
  readonly maxDiffPixels: number | undefined;
  readonly maxDiffPixelRatio: number | undefined;
}

/** What comparing two images found. */
export type ImageComparison =
  | { readonly kind: 'match'; readonly diffPixels: number }
  | { readonly kind: 'size'; readonly expected: ImageBox; readonly actual: ImageBox }
  | { readonly kind: 'pixels'; readonly diffPixels: number; readonly ratio: number; readonly diff: RgbaImage };

/**
 * Compares `actual` against `expected`. They match when they have one size
 * and at most the tolerated number of pixels differ: `maxDiffPixels`, a
 * `maxDiffPixelRatio` share of the image, the smaller of the two when both are
 * set, and none when neither is.
 */
export function compareImages(expected: RgbaImage, actual: RgbaImage, tolerance: ImageTolerance): ImageComparison {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      kind: 'size',
      expected: { x: 0, y: 0, width: expected.width, height: expected.height },
      actual: { x: 0, y: 0, width: actual.width, height: actual.height },
    };
  }
  const { width, height } = expected;
  const diff = new Uint8Array(width * height * 4);
  const diffPixels = pixelmatch(expected.data, actual.data, diff, width, height, { threshold: tolerance.threshold });
  const total = width * height;
  const byRatio = tolerance.maxDiffPixelRatio === undefined ? undefined : total * tolerance.maxDiffPixelRatio;
  const allowed =
    tolerance.maxDiffPixels !== undefined && byRatio !== undefined
      ? Math.min(tolerance.maxDiffPixels, byRatio)
      : (tolerance.maxDiffPixels ?? byRatio ?? 0);
  if (diffPixels <= allowed) return { kind: 'match', diffPixels };
  return { kind: 'pixels', diffPixels, ratio: total === 0 ? 0 : diffPixels / total, diff: { width, height, data: diff } };
}
