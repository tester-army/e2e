/**
 * Primitives for reading untrusted JSON-shaped values.
 *
 * Every closed grammar in the runner — the cache document, the locator
 * expression, the `agent-tool-1` response — starts by asking the same two
 * questions of a value it did not create: is this a plain object, and is this a
 * string within bounds. They live here so a reader and the writer it mirrors
 * cannot answer them differently.
 */

/** One plain JSON object, or undefined for anything else including arrays. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A string of `min` through `max` characters, or undefined. */
export function boundedString(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length < min || value.length > max) return undefined;
  return value;
}

/** True when the record carries no key outside the allowed set. */
export function closedRecord(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((key) => allowed.includes(key));
}

/**
 * Serializes a value with object keys in sorted order, so two structurally equal
 * values always render identically.
 *
 * Plain `JSON.stringify` is key-insertion-order sensitive, which makes it a trap
 * for comparing a value this process just built against one it read back from
 * disk: the two are equal only while the literals that construct them happen to
 * list their fields in the same order, in two different files, forever. An
 * equality that fails silently — dropped cache guidance, a rewritten identical
 * entry — is worse than one that fails loudly, so ordering is removed from the
 * question rather than relied upon.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}
