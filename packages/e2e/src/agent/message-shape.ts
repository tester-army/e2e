/**
 * What a message holds, as the model reads it, for telling a rewritten
 * message from one carried forward. Anthropic binds a thinking block to the
 * messages before it and rejects a replay after any of them changed, so the
 * loop compares each turn's history with what the last request sent: by
 * value, since an executor may edit a message through the object it was
 * handed or hand back a clone of a history it did not change.
 */

import type { ModelMessage } from 'ai';

/** A message's content serialized without provider options, and its binary payloads copied. */
export interface MessageShape {
  readonly text: string;
  readonly binaries: readonly Uint8Array[];
}

/** Keys a message carries for the provider, not for the model: a moved cache breakpoint or a signature is no edit. */
const PROVIDER_KEYS = new Set(['providerOptions', 'providerMetadata']);

/** The shape of one message. Bytes are copied, so an edit to the live array after the snapshot still shows. */
export function shapeOf(message: ModelMessage): MessageShape {
  const binaries: Uint8Array[] = [];
  const chunks: string[] = [];
  const walk = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      binaries.push(Uint8Array.from(value));
      chunks.push(`<bytes ${String(value.byteLength)}>`);
    } else if (value instanceof ArrayBuffer) {
      walk(new Uint8Array(value));
    } else if (Array.isArray(value)) {
      chunks.push('[');
      for (const item of value) walk(item);
      chunks.push(']');
    } else if (typeof value === 'object' && value !== null && !(value instanceof URL)) {
      chunks.push('{');
      for (const [key, item] of Object.entries(value)) {
        if (PROVIDER_KEYS.has(key) || item === undefined) continue;
        chunks.push(JSON.stringify(key), ':');
        walk(item);
      }
      chunks.push('}');
    } else {
      chunks.push(JSON.stringify(value instanceof URL ? value.href : value), ',');
    }
  };
  walk(message);
  return { text: chunks.join(''), binaries };
}

/** Whether two shapes send the model the same message. */
export function sameShape(a: MessageShape, b: MessageShape): boolean {
  return a.text === b.text && a.binaries.length === b.binaries.length && a.binaries.every((bytes, index) => sameBytes(bytes, b.binaries[index]!));
}

/** Whether two payloads hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
