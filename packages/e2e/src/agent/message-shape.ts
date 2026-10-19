/**
 * What a message holds, as the model reads it, for telling a rewritten
 * message from one carried forward. Anthropic binds a thinking block to the
 * messages before it and rejects a replay after any of them changed, so the
 * loop compares each turn's history with what the last request sent: by
 * value, since an executor may edit a message through the object it was
 * handed or hand back a clone of a history it did not change.
 */

import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';

/** Keys a message carries for the provider, not for the model: a moved cache breakpoint or a signature is no edit. */
const PROVIDER_KEYS = new Set(['providerOptions', 'providerMetadata']);

/**
 * A digest of one message's content, taken when it is sent, so an edit to
 * the live message afterwards, bytes included, shows against it.
 */
export function shapeOf(message: ModelMessage): string {
  const hash = createHash('sha256');
  const walk = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      hash.update(`<bytes ${String(value.byteLength)}>`);
      hash.update(value);
    } else if (value instanceof ArrayBuffer) {
      walk(new Uint8Array(value));
    } else if (Array.isArray(value)) {
      hash.update('[');
      for (const item of value) walk(item);
      hash.update(']');
    } else if (typeof value === 'object' && value !== null && !(value instanceof URL)) {
      hash.update('{');
      for (const [key, item] of Object.entries(value)) {
        if (PROVIDER_KEYS.has(key) || item === undefined) continue;
        hash.update(JSON.stringify(key));
        hash.update(':');
        walk(item);
      }
      hash.update('}');
    } else {
      hash.update(JSON.stringify(value instanceof URL ? value.href : value));
      hash.update(',');
    }
  };
  walk(message);
  return hash.digest('hex');
}
