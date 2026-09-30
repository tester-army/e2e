/** Opaque secret and credential handles. */

import { credentialBrand, secretBrand } from './internal/brands.ts';
import { ConfigurationError } from './internal/errors.ts';
import { realmSlot } from './internal/realm-slot.ts';
import { credentialOfSecretName, credentialSecretName, envName } from './config/secrets.ts';
import type { Credential, Credentials, Secret, SecretPurpose, Secrets } from './types.ts';

/**
 * What the handles resolve against: the run's accounts and every secret by
 * name, as the two maps the resolved config carries. Named structurally
 * rather than picked from `ResolvedConfig`, so the public `secrets` surface
 * pulls no config module, and none of its imports, into a consumer's types.
 */
export interface SecretRegistry {
  readonly credentials: ReadonlyMap<string, { readonly username: string }>;
  readonly secrets: ReadonlyMap<string, { readonly purpose: SecretPurpose }>;
}

/** Global slot so test modules in an isolated realm reach the runner's registry. */
const registrySlot = realmSlot<SecretRegistry>('e2e.secrets.v1');

/** Installed by the runner once config resolution completes. */
export function setSecretRegistry(registry: SecretRegistry | undefined): void {
  if (registry === undefined) registrySlot.delete(globalThis);
  else registrySlot.set(globalThis, registry);
}

/** The registries standalone attempts hold, oldest first; the newest is the one installed. */
const holds: { readonly registry: SecretRegistry }[] = [];

/**
 * Installs `registry` for a standalone attempt until the returned release
 * runs. Several attempts may hold one at once, as live sessions do: releasing
 * one installs the newest registry still held, and releasing the last clears
 * the slot, so closing one session never leaves another resolving against
 * none.
 */
export function holdSecretRegistry(registry: SecretRegistry): () => void {
  const hold = { registry };
  holds.push(hold);
  registrySlot.set(globalThis, registry);
  return () => {
    const index = holds.indexOf(hold);
    if (index === -1) return;
    holds.splice(index, 1);
    // A registry installed since, by a newer hold or by a run, stays installed.
    if (registrySlot.get(globalThis) !== registry) return;
    const newest = holds.at(-1);
    if (newest === undefined) registrySlot.delete(globalThis);
    else registrySlot.set(globalThis, newest.registry);
  };
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

/**
 * The handle `secrets.get()` returns before any run installed a registry: at
 * config evaluation, where an engine option holds it until the engine
 * resolves it during an attempt. `secrets.get()` names a `config.secrets`
 * entry, never a credential's password, so the purpose is known up front;
 * the config load checks the name. Turned into a string
 * (a template literal, `String()`, `+`, `JSON.stringify`) it throws: the
 * config holds a name, not the value, and a string would pass the name off
 * as the value where only a string fits, a command's env or an agent's context.
 */
function deferredSecret(name: string): Secret {
  const notAValue = (): never => {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `secrets.get(${JSON.stringify(name)}) is a reference to a secret, not its value: only an engine option that declares secrets accepts it, such as web({ basicAuth: { password } }); where a string is needed, such as a command's env or an agent's context, read the value yourself (process.env)`,
    );
  };
  const handle = { name, purpose: 'generic-secret' as const, [secretBrand]: true as const };
  Object.defineProperties(handle, {
    toString: { value: notAValue },
    toJSON: { value: notAValue },
    [Symbol.toPrimitive]: { value: notAValue },
  });
  return Object.freeze(handle);
}

/** Whether a value is a `Secret` handle, from this module instance or another realm's. */
export function isSecret(value: unknown): value is Secret {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[secretBrand] === true
  );
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
      password: makeSecret(credentialSecretName(name), 'password'),
      [credentialBrand]: true as const,
    });
  },
};

export const secrets: Secrets = {
  get(name: string): Secret {
    const registry = registrySlot.get(globalThis);
    if (registry === undefined) return deferredSecret(name);
    const resolved = registry.secrets.get(name);
    if (resolved?.purpose === 'password') {
      throw new ConfigurationError(
        'SECRET_UNAVAILABLE',
        `secret "${name}" is a credential's password, not a config.secrets entry; use credentials.user(${JSON.stringify(credentialOfSecretName(name) ?? name)}).password`,
      );
    }
    if (resolved === undefined) {
      const credential = registry.credentials.has(name) ? `; "${name}" is a credential, whose password is credentials.user(${JSON.stringify(name)}).password` : '';
      throw new ConfigurationError(
        'SECRET_UNAVAILABLE',
        `secret "${name}" is not configured; add it to config.secrets or set ${envName('E2E_SECRET', name)}${credential}`,
      );
    }
    return makeSecret(name, resolved.purpose);
  },
};
