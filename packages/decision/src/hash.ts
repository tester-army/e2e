/** FNV-1a over text and bytes, as a base-36 string: the one hash the package fingerprints with. */
export function fnv1a(parts: Iterable<string | Uint8Array>): string {
  let hash = 2166136261;
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let index = 0; index < part.length; index += 1) {
        hash ^= part.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    } else {
      for (const byte of part) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
      }
    }
    hash ^= 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
