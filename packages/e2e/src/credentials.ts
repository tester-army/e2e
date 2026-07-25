/** Opaque credential handles (spec 02-test-api.md, 14-security.md). */

import { credentialBrand, secretBrand } from './internal/brands.js';
import { ConfigurationError } from './internal/errors.js';
import type { ResolvedCredential } from './config/resolve.js';
import type { Credential, Credentials, Secret } from './types.js';

/** Global slot so test modules in an isolated realm reach the runner's registry. */
const CREDENTIALS_SLOT = Symbol.for('e2e.credentials.v1');

type GlobalWithCredentials = typeof globalThis & {
  [CREDENTIALS_SLOT]?: ReadonlyMap<string, ResolvedCredential>;
};

/** Installed by the runner once config resolution completes. */
export function setCredentialRegistry(map: ReadonlyMap<string, ResolvedCredential> | undefined): void {
  const slot = globalThis as GlobalWithCredentials;
  if (map === undefined) delete slot[CREDENTIALS_SLOT];
  else slot[CREDENTIALS_SLOT] = map;
}

function getRegistry(): ReadonlyMap<string, ResolvedCredential> | undefined {
  return (globalThis as GlobalWithCredentials)[CREDENTIALS_SLOT];
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
