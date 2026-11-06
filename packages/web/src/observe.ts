/** Reading screenshot bytes: the pixel size a PNG reports. */

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
