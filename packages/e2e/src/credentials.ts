/** Opaque credential handles. */

import { credentialBrand, secretBrand } from './internal/brands.ts';
import { ConfigurationError } from './internal/errors.ts';
import { realmSlot } from './internal/realm-slot.ts';
import type { ResolvedCredential } from './config/resolve.ts';
import type { Credential, Credentials, Secret } from './types.ts';

/** Global slot so test modules in an isolated realm reach the runner's registry. */
const credentialsSlot = realmSlot<ReadonlyMap<string, ResolvedCredential>>('e2e.credentials.v1');

/** Installed by the runner once config resolution completes. */
export function setCredentialRegistry(map: ReadonlyMap<string, ResolvedCredential> | undefined): void {
  if (map === undefined) credentialsSlot.delete(globalThis);
  else credentialsSlot.set(globalThis, map);
}

/**
 * Removes `map` from the slot if it is still the installed registry. A host
 * that closes one attempt while opening the next must not wipe what the new
 * attempt just installed.
 */
export function releaseCredentialRegistry(map: ReadonlyMap<string, ResolvedCredential>): void {
  if (credentialsSlot.get(globalThis) === map) credentialsSlot.delete(globalThis);
}

function getRegistry(): ReadonlyMap<string, ResolvedCredential> | undefined {
  return credentialsSlot.get(globalThis);
}

function makeSecret(name: string): Secret {
  return Object.freeze({
    name,
    purpose: 'password' as const,
    [secretBrand]: true as const,
  });
}

export const credentials: Credentials = {
  user(name: string): Credential {
    const registry = getRegistry();
    if (registry === undefined) {
      throw new ConfigurationError(
        'AUTH_CREDENTIAL_UNAVAILABLE',
        'credentials.user() is only available while the e2e runner is active',
      );
    }
    const resolved = registry.get(name);
    if (resolved === undefined) {
      throw new ConfigurationError(
        'AUTH_CREDENTIAL_UNAVAILABLE',
        `credential "${name}" is not configured; add it to config.credentials or E2E_USER_* variables`,
      );
    }
    return Object.freeze({
      name,
      username: resolved.username,
      password: makeSecret(name),
      [credentialBrand]: true as const,
    });
  },
};
