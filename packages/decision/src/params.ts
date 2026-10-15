import type { JsonValue } from 'e2e';
/** The step params minus secret projections, which travel only as handles. */
export function nonSecretParams(params: Readonly<Record<string, JsonValue>> | undefined): Record<string, JsonValue> {
  const kept: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    const cleaned = withoutSecret(value);
    if (cleaned === undefined) continue;
    setKey(kept, key, cleaned);
  }
  return kept;
}
/** Removes secret-marker leaves at any depth. Undefined means the value itself was one. */
function withoutSecret(value: JsonValue): JsonValue | undefined {
  if (Array.isArray(value)) return value.map((item) => withoutSecret(item) ?? null);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, JsonValue>;
    if (record['kind'] === 'secret') return undefined;
    const kept: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(record)) {
      const cleaned = withoutSecret(item);
      if (cleaned === undefined) continue;
      setKey(kept, key, cleaned);
    }
    return kept;
  }
  return value;
}
/** Assigns an own property even for `__proto__`, which a plain assignment would not create. */
function setKey(record: Record<string, JsonValue>, key: string, value: JsonValue): void {
  if (key === '__proto__') {
    Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    record[key] = value;
  }
}
