/** Minimal PNG header reading: the geometry a vision token bound needs, nothing more. */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Width and height from the IHDR chunk, which the PNG format requires to be
 * the first chunk after the signature. Undefined for anything that is not a
 * well-formed PNG header; callers treat that as "no image".
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 24) return undefined;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return undefined;
  }
  // Bytes 12..16 spell the chunk type of the first chunk.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}
