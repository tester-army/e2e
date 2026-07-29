/** Masked pixel capture for an observation (spec 09-drivers.md, 14-security.md). */

import type { Page } from 'playwright';
import type { ObservationPixels, OperationContext } from '../driver/index.ts';
import { SECURE_FIELD_SELECTOR } from './read-node.ts';

/**
 * Budget for one masked screenshot, still capped by the operation timeout. A
 * heavy page that cannot produce a frame promptly must cost the observation a
 * moment, not the whole step: the caller degrades to tree-only input rather
 * than failing.
 */
const PIXEL_CAPTURE_TIMEOUT_MS = 10_000;

/** Opaque fill covering every masked region. */
const MASK_COLOR = '#000000';

export interface PixelCapture {
  readonly pixels: ObservationPixels;
  readonly maskedRegionCount: number;
}

/**
 * Captures masked viewport pixels.
 *
 * Secure fields are covered before the image leaves the backend and the covered
 * regions are counted, so the runner can prove the image is at least as redacted
 * as the tree. The sweep runs over every frame Playwright can reach rather than
 * only the frames the observation walked, which makes the masked set a superset
 * of the observed secure set — the direction that is safe, and the one the
 * runner's clearance check requires.
 *
 * `scale: 'css'` keeps the image in the CSS pixel space every observed node rect
 * already uses, which is what lets the runner hit-test a point against the same
 * tree.
 */
export async function capturePixels(
  page: Page,
  operation: OperationContext,
  viewport: { readonly width: number; readonly height: number },
  options: { readonly scale?: number; readonly resize?: Resizer } = {},
): Promise<PixelCapture> {
  const masks = page.frames().map((frame) => frame.locator(SECURE_FIELD_SELECTOR));
  // A frame that detaches mid-sweep contributes nothing to the count, which can
  // only push the observation toward withholding the image.
  const counts = await Promise.all(masks.map((mask) => mask.count().catch(() => 0)));
  const image = await page.screenshot({
    type: 'png',
    scale: 'css',
    animations: 'disabled',
    caret: 'hide',
    timeout: Math.max(1, Math.min(operation.timeoutMs, PIXEL_CAPTURE_TIMEOUT_MS)),
    ...(masks.length === 0 ? {} : { mask: masks, maskColor: MASK_COLOR }),
  });
  const data = await downscale(new Uint8Array(image), options);
  // The bytes are the authority on their own size. `scale: 'css'` is asked for
  // precisely so one image pixel is one CSS pixel, but the ratio is measured
  // rather than assumed: if a capture ever comes back at device scale, reporting
  // the viewport instead would displace every coordinate the model reads off it.
  const size = readPngSize(data) ?? { width: viewport.width, height: viewport.height };
  return {
    pixels: {
      data,
      mediaType: 'image/png',
      width: size.width,
      height: size.height,
      scale: viewport.width > 0 ? size.width / viewport.width : 1,
    },
    maskedRegionCount: counts.reduce((total, count) => total + count, 0),
  };
}

/**
 * Resamples PNG bytes to a fraction of their size, or returns them unchanged.
 *
 * Resizing runs where an image decoder already exists — in the browser — rather
 * than pulling a native image dependency into the runner. It happens after
 * masking, so the black regions are resampled along with everything else and no
 * redacted pixel can reappear. A resizer that fails returns the full-scale bytes:
 * the geometry is measured from whatever comes back, so a skipped resize costs
 * tokens, never correctness.
 */
export async function downscale(
  data: Uint8Array,
  options: { readonly scale?: number; readonly resize?: Resizer },
): Promise<Uint8Array> {
  const { scale, resize } = options;
  if (scale === undefined || scale >= 1 || resize === undefined) return data;
  try {
    return await resize(data, scale);
  } catch {
    return data;
  }
}

/** Resamples PNG bytes to `scale`, returning PNG bytes. */
export type Resizer = (data: Uint8Array, scale: number) => Promise<Uint8Array>;

/**
 * The in-page half of the resize, evaluated in a scratch page.
 *
 * It is a standalone function so the driver can hand it to `evaluate` without
 * closing over anything, and so the arithmetic that decides the target size
 * lives next to the code that reads the result back.
 */
export const resizeImageFunction = async (input: {
  bytes: readonly number[];
  scale: number;
}): Promise<number[]> => {
  const source = new Blob([new Uint8Array(input.bytes)], { type: 'image/png' });
  const bitmap = await createImageBitmap(source);
  const width = Math.max(1, Math.round(bitmap.width * input.scale));
  const height = Math.max(1, Math.round(bitmap.height * input.scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const encoded = await canvas.convertToBlob({ type: 'image/png' });
  return [...new Uint8Array(await encoded.arrayBuffer())];
};

/**
 * Reads pixel dimensions out of PNG bytes.
 *
 * The dimensions reported with a screenshot must be the dimensions of the bytes
 * the model actually receives: every coordinate it returns is relative to them,
 * so a viewport value that disagrees with the capture displaces every point
 * silently. PNG puts IHDR first, so width and height are at fixed offsets and no
 * decoder is needed.
 */
export function readPngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;
  if (view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
