/** PNG header reading for images the runner hands a model. */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Reads the dimensions out of a PNG's IHDR chunk, which the format places
 * first at fixed offsets; undefined for anything that is not a PNG. Engines
 * carry their own copy of this check; the runner needs one for a screenshot
 * it reads back from disk.
 */
export function pngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (data[index] !== PNG_SIGNATURE[index]) return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}
