/** Opaque secret and credential handles. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { credentialBrand, secretBrand } from './internal/brands.ts';
import { ConfigurationError } from './internal/errors.ts';
import { realmSlot } from './internal/realm-slot.ts';
import { credentialNamed, envName } from './config/secrets.ts';
import type { Credential, Credentials, Secret, SecretPurpose, Secrets } from './types.ts';

/** One secret as the registry knows it: its name and what it is for. */
interface RegisteredSecret {
  readonly name: string;
  readonly purpose: SecretPurpose;
}

/**
 * What the handles resolve against, as the resolved config carries it: the
 * run's accounts, the `config.secrets` entries, and every secret the run
 * holds. Named structurally rather than picked from `ResolvedConfig`, so the
 * public `secrets` surface pulls no config module, and none of its imports,
 * into a consumer's types.
 */
export interface SecretRegistry {
  readonly credentials: ReadonlyMap<string, { readonly name: string; readonly username: string; readonly password: RegisteredSecret }>;
  readonly secrets: ReadonlyMap<string, RegisteredSecret>;
  readonly allSecrets: ReadonlyMap<string, RegisteredSecret>;
}

/** Global slot so test modules in an isolated realm reach the runner's registry. */
const registrySlot = realmSlot<SecretRegistry>('e2e.secrets.v1');

/** Config evaluation creates references, never handles bound to another run's registry. */
const configReferences = realmSlot<AsyncLocalStorage<true>>('e2e.secrets.config-references.v1');

/** Async-local and realm-shared: concurrent attempts keep their own registry untouched. */
export function withConfigSecretReferences<T>(load: () => T): T {
  let scope = configReferences.get(globalThis);
  if (scope === undefined) {
    scope = new AsyncLocalStorage<true>();
    configReferences.set(globalThis, scope);
  }
  return scope.run(true, load);
}

/**
 * The registries secrets resolve against, in layers: the base a run worker
 * installs, and the holds standalone workers and attempts stack on it, oldest
 * first. Realm-shared like the installed registry, so every copy of e2e
 * stacks on the same layers.
 */
interface RegistryLayers {
  base: SecretRegistry | undefined;
  readonly holds: { readonly registry: SecretRegistry; readonly live: boolean }[];
}

const layersSlot = realmSlot<RegistryLayers>('e2e.secrets.layers.v1');

/** The realm's registry layers, created on first use. */
function registryLayers(): RegistryLayers {
  let layers = layersSlot.get(globalThis);
  if (layers === undefined) {
    layers = { base: undefined, holds: [] };
    layersSlot.set(globalThis, layers);
  }
  return layers;
}

/** Installs the registry lookups resolve against: the newest live hold's, else the newest hold's, else the base. */
function installTop(layers: RegistryLayers): void {
  const registry = (layers.holds.findLast((hold) => hold.live) ?? layers.holds.at(-1))?.registry ?? layers.base;
  if (registry === undefined) registrySlot.delete(globalThis);
  else registrySlot.set(globalThis, registry);
}

/** Installed by the runner once config resolution completes: the base layer, under any hold still open. */
export function setSecretRegistry(registry: SecretRegistry | undefined): void {
  const layers = registryLayers();
  layers.base = registry;
  installTop(layers);
}

/**
 * Stacks `registry` on the installed ones for a standalone worker or attempt
 * until the returned release runs. Lookups resolve against the newest live
 * hold, else the newest hold, else the base a run worker installed, so
 * closing one session never leaves another resolving against none. A `live`
 * hold is an attempt's: it outranks a worker that opens while the attempt
 * runs, whose config would otherwise capture the attempt's handles. A
 * registry with no secrets and no credentials (an engine opened with no
 * config, as `attachBrowser` does) holds nothing, so it hides nothing.
 */
export function holdSecretRegistry(registry: SecretRegistry, options: { readonly live?: boolean } = {}): () => void {
  if (registry.secrets.size === 0 && registry.credentials.size === 0) return () => undefined;
  const layers = registryLayers();
  const hold = { registry, live: options.live === true };
  layers.holds.push(hold);
  installTop(layers);
  return () => {
    const index = layers.holds.indexOf(hold);
    if (index === -1) return;
    layers.holds.splice(index, 1);
    installTop(layers);
  };
}

/**
 * The code an unresolvable secret fails with: a credential's password is a
 * credential problem, any other secret a secret problem.
 */
export function unavailableCode(secret: Pick<Secret, 'purpose'>): 'AUTH_CREDENTIAL_UNAVAILABLE' | 'SECRET_UNAVAILABLE' {
  return secret.purpose === 'password' ? 'AUTH_CREDENTIAL_UNAVAILABLE' : 'SECRET_UNAVAILABLE';
}

/** The installed registry, unless a config is being evaluated: its handles stay references. */
function currentRegistry(): SecretRegistry | undefined {
  if (configReferences.get(globalThis)?.getStore() === true) return undefined;
  return registrySlot.get(globalThis);
}

function requireRegistry(caller: string, code: 'AUTH_CREDENTIAL_UNAVAILABLE' | 'SECRET_UNAVAILABLE'): SecretRegistry {
  const registry = currentRegistry();
  if (registry === undefined) {
    throw new ConfigurationError(code, `${caller} is only available while the e2e runner is active`);
  }
  return registry;
}

/** The opaque handle of a secret the registry holds, for a host that hands every configured secret to a step (`e2e mcp`). */
export function secretHandle({ name, purpose }: RegisteredSecret): Secret {
  return Object.freeze({ name, purpose, [secretBrand]: true as const });
}

/**
 * The handle `secrets.get()` returns before any run installed a registry: at
 * config evaluation, where an engine option holds it until the engine
 * resolves it during an attempt. Only the resolved config knows whether the
 * name is a credential's password (`admin.password`), so the purpose is read
 * from the run's registry when asked; the config load checks the name. Turned into a string
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
  const handle = {
    name,
    get purpose(): SecretPurpose {
      return currentRegistry()?.allSecrets.get(name)?.purpose ?? 'generic-secret';
    },
    [secretBrand]: true as const,
  };
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
      password: secretHandle(resolved.password),
      [credentialBrand]: true as const,
    });
  },
};

export const secrets: Secrets = {
  get(name: string): Secret {
    const registry = currentRegistry();
    if (registry === undefined) return deferredSecret(name);
    const resolved = registry.secrets.get(name);
    if (resolved === undefined) {
      const credential = credentialNamed(name, registry.credentials);
      const hint = credential === undefined ? '' : `; credential "${credential.name}"'s password is credentials.user(${JSON.stringify(credential.name)}).password`;
      throw new ConfigurationError(
        'SECRET_UNAVAILABLE',
        `secret "${name}" is not configured; add it to config.secrets or set ${envName('E2E_SECRET', name)}${hint}`,
      );
    }
    return secretHandle(resolved);
  },
};
