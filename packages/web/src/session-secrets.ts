/**
 * Values the browser carries that the harness never sees pass: the gate
 * credentials an attempt sends on every request, and the cookies and storage
 * a session snapshot restores. Each is handed to the harness for redaction,
 * so a trace that recorded it is rewritten before it is kept.
 */

import { EngineError } from 'e2e/engine';
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
  register: SecretRegistrar | undefined,
  headers: Readonly<Record<string, string>> | undefined,
  basicAuth: WebBasicAuth | undefined,
): void {
  const values: (readonly [string, string])[] = Object.entries(headers ?? {})
    .filter(([, value]) => value.length >= MIN_REGISTERED_LENGTH)
    .map(([name, value]) => [`header.${name}`, value] as const);
  if (basicAuth !== undefined) values.push(['basicAuth.password', basicAuth.password]);
  registerAll(register, values);
}

/**
 * Registers the cookie and local-storage values of a snapshot long enough to
 * be a token, under `cookie.<name>` and `storage.<key>`. IndexedDB records
 * are not walked: their shape is the app's.
 */
export function registerStateSecrets(register: SecretRegistrar | undefined, state: StorageState): void {
  const values: (readonly [string, string])[] = [];
  for (const cookie of state.cookies) {
    if (cookie.value.length >= MIN_REGISTERED_LENGTH) values.push([`cookie.${cookie.name}`, cookie.value]);
  }
  for (const origin of state.origins) {
    for (const entry of origin.localStorage) {
      if (entry.value.length >= MIN_REGISTERED_LENGTH) values.push([`storage.${entry.name}`, entry.value]);
    }
  }
  registerAll(register, values);
}

/**
 * Hands `values` to the harness, or refuses when the runner predates the
 * member: the peer range on `e2e` admits an older runner, and a value it
 * cannot redact must not go on the wire under a clean label. With nothing to
 * register, an older runner is fine.
 */
function registerAll(register: SecretRegistrar | undefined, values: readonly (readonly [string, string])[]): void {
  if (values.length === 0) return;
  if (typeof register !== 'function') {
    throw new EngineError(
      'ENGINE_FAILURE',
      'this e2e runner predates EngineAttemptContext.registerSecret, which @e2edev/web needs before it sends a configured header, a basic-auth password, or a restored session value; update e2e to the release this engine shipped with',
      { retryable: false },
    );
  }
  for (const [name, value] of values) register(name, value);
}
