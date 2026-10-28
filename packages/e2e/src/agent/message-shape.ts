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
  const json = JSON.stringify(message, function (this: Record<string, unknown>, key: string, value: unknown) {
    if (PROVIDER_KEYS.has(key)) return undefined;
    // Read from the holder: a Buffer has been through its own `toJSON` by the time `value` arrives.
    const raw = this[key];
    if (raw instanceof ArrayBuffer) return `<bytes ${sha256(new Uint8Array(raw))}>`;
    return raw instanceof Uint8Array ? `<bytes ${sha256(raw)}>` : value;
  });
  return sha256(json);
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
