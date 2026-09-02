/** Masked pixel capture for an observation (spec 14-security.md). */

import type { Locator, Page } from 'playwright';
import type { ObservationPixels, OperationContext } from 'e2e/backend';
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

/**
 * One mask locator per frame Playwright can reach, covering every secure
 * field. Sweeping every frame rather than only the frames an observation
 * walked makes the masked set a superset of the observed secure set - the
 * direction that is safe. Shared by the observation pixels and the artifact
 * screenshot so both are redacted at the source by the same rule.
 */
export function secureFieldMasks(page: Page): Locator[] {
  return page.frames().map((frame) => frame.locator(SECURE_FIELD_SELECTOR));
}

/** Screenshot options that apply the secure-field masks; empty when there is no frame to mask. */
export function maskOptions(masks: readonly Locator[]): Partial<{ mask: Locator[]; maskColor: string }> {
  return masks.length === 0 ? {} : { mask: [...masks], maskColor: MASK_COLOR };
}

export interface PixelCapture {
  readonly pixels: ObservationPixels;
  readonly maskedRegionCount: number;
}

/**
 * Captures masked viewport pixels.
 *
 * Secure fields are covered before the image leaves the backend and the covered
 * regions are counted, so the runner can prove the image is at least as redacted
 * as the tree (the runner's clearance check requires the masked set to be a
 * superset of the observed secure set, which `secureFieldMasks` guarantees).
 *
 * `scale: 'css'` keeps the image in the CSS pixel space every observed node rect
 * already uses, which is what lets the runner hit-test a point against the same
 * tree.
 */
export async function capturePixels(
  page: Page,
  operation: OperationContext,
  viewport: { readonly width: number; readonly height: number },
): Promise<PixelCapture> {
  const masks = secureFieldMasks(page);
  // A frame that detaches mid-sweep contributes nothing to the count, which can
  // only push the observation toward withholding the image.
  const counts = await Promise.all(masks.map((mask) => mask.count().catch(() => 0)));
  const image = await page.screenshot({
    type: 'png',
    scale: 'css',
    animations: 'disabled',
    caret: 'hide',
    timeout: Math.max(1, Math.min(operation.timeoutMs, PIXEL_CAPTURE_TIMEOUT_MS)),
    ...maskOptions(masks),
  });
  const data = new Uint8Array(image);
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
