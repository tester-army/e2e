/** Screenshot masking policy; PNG parsing and encoding belong to pngjs. */
import { PNG } from 'pngjs';
import type { Rect } from './support.ts';

/** Paints each requested rectangle opaque black, rounding outward and clipping to the image. */
export function maskPng(bytes: Uint8Array, rects: readonly Rect[]): Uint8Array {
  if (rects.length === 0) return bytes;
  const image = PNG.sync.read(Buffer.from(bytes));
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
  return PNG.sync.write(image);
}
