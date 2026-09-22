/**
 * Values the browser carries that the harness never sees pass: the gate
 * credentials an attempt sends on every request, and the cookies and storage
 * a session snapshot restores. Each is handed to the harness for redaction,
 * so a trace that recorded it is rewritten before it is kept.
 */

import type { StorageState } from './attempt-session.ts';
import type { WebBasicAuth } from './surface.ts';

/** The harness's per-attempt registrar; see `EngineAttemptContext.registerSecret`. */
export type SecretRegistrar = (name: string, value: string) => void;

/**
 * Shortest value registered from a header, a cookie, or a storage entry. A
 * registered value is rewritten wherever it occurs, in model input included,
 * so a short one (`en`, `dark`, `true`, a timestamp) would mangle every
 * screen that happens to contain it; a token is longer than this.
 */
const MIN_REGISTERED_LENGTH = 16;

/**
 * Registers the credentials that reach the app on every request: each
 * configured header value long enough to be a token, under `header.<name>`,
 * and the basic-auth password whatever its length, since a password is a
 * secret by definition.
 */
export function registerGateSecrets(
  register: SecretRegistrar,
  headers: Readonly<Record<string, string>> | undefined,
  basicAuth: WebBasicAuth | undefined,
): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value.length >= MIN_REGISTERED_LENGTH) register(`header.${name}`, value);
  }
  if (basicAuth !== undefined) register('basicAuth.password', basicAuth.password);
}

/**
 * Registers the cookie and local-storage values of a snapshot long enough to
 * be a token, under `cookie.<name>` and `storage.<key>`. IndexedDB records
 * are not walked: their shape is the app's.
 */
export function registerStateSecrets(register: SecretRegistrar, state: StorageState): void {
  for (const cookie of state.cookies) {
    if (cookie.value.length >= MIN_REGISTERED_LENGTH) register(`cookie.${cookie.name}`, cookie.value);
  }
  for (const origin of state.origins) {
    for (const entry of origin.localStorage) {
      if (entry.value.length >= MIN_REGISTERED_LENGTH) register(`storage.${entry.name}`, entry.value);
    }
  }
}
