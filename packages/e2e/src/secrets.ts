/** Opaque secret and credential handles. */

import { credentialBrand, secretBrand } from './internal/brands.ts';
import { ConfigurationError } from './internal/errors.ts';
import { realmSlot } from './internal/realm-slot.ts';
import type { ResolvedConfig } from './config/resolve.ts';
import { envName } from './config/secrets.ts';
import type { Credential, Credentials, Secret, SecretPurpose, Secrets } from './types.ts';

/** What the handles resolve against: the run's accounts and every secret by name. */
export type SecretRegistry = Pick<ResolvedConfig, 'credentials' | 'secrets'>;

/** Global slot so test modules in an isolated realm reach the runner's registry. */
const registrySlot = realmSlot<SecretRegistry>('e2e.secrets.v1');

/** Installed by the runner once config resolution completes. */
export function setSecretRegistry(registry: SecretRegistry | undefined): void {
  if (registry === undefined) registrySlot.delete(globalThis);
  else registrySlot.set(globalThis, registry);
}

/**
 * Removes `registry` from the slot if it is still the installed one. A host
 * that closes one attempt while opening the next must not wipe what the new
 * attempt just installed.
 */
export function releaseSecretRegistry(registry: SecretRegistry): void {
  if (registrySlot.get(globalThis) === registry) registrySlot.delete(globalThis);
}

/**
 * The code an unresolvable secret fails with: a credential's password is a
 * credential problem, any other secret a secret problem.
 */
export function unavailableCode(secret: Pick<Secret, 'purpose'>): 'AUTH_CREDENTIAL_UNAVAILABLE' | 'SECRET_UNAVAILABLE' {
  return secret.purpose === 'password' ? 'AUTH_CREDENTIAL_UNAVAILABLE' : 'SECRET_UNAVAILABLE';
}

function requireRegistry(caller: string, code: 'AUTH_CREDENTIAL_UNAVAILABLE' | 'SECRET_UNAVAILABLE'): SecretRegistry {
  const registry = registrySlot.get(globalThis);
  if (registry === undefined) {
    throw new ConfigurationError(code, `${caller} is only available while the e2e runner is active`);
  }
  return registry;
}

function makeSecret(name: string, purpose: SecretPurpose): Secret {
  return Object.freeze({ name, purpose, [secretBrand]: true as const });
}

export const credentials: Credentials = {
  user(name: string): Credential {
    const registry = requireRegistry('credentials.user()', 'AUTH_CREDENTIAL_UNAVAILABLE');
    const resolved = registry.credentials.get(name);
    if (resolved === undefined) {
      throw new ConfigurationError(
        'AUTH_CREDENTIAL_UNAVAILABLE',
        `credential "${name}" is not configured; add it to config.credentials or E2E_USER_* variables`,
      );
    }
    return Object.freeze({
      name,
      username: resolved.username,
      password: makeSecret(name, 'password'),
      [credentialBrand]: true as const,
    });
  },
};

export const secrets: Secrets = {
  get(name: string): Secret {
    const registry = requireRegistry('secrets.get()', 'SECRET_UNAVAILABLE');
    const resolved = registry.secrets.get(name);
    if (resolved === undefined) {
      throw new ConfigurationError(
        'SECRET_UNAVAILABLE',
        `secret "${name}" is not configured; add it to config.secrets or set ${envName('E2E_SECRET', name)}`,
      );
    }
    return makeSecret(name, resolved.purpose);
  },
};
