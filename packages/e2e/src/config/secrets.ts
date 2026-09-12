/**
 * Secret and credential declarations: the public types a test or config
 * spells, and the rules that read them (the env-variable name a declaration
 * answers to, what counts as a value, the one shape a `secrets` entry
 * normalizes to). `types.ts` re-exports the types; `resolve.ts` and the
 * handle module apply the rules.
 */

import type { credentialBrand, secretBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { didYouMean } from '../internal/suggest.ts';
import { sameSite } from '../internal/urls.ts';

/**
 * What a secret is for, which decides where it may be filled: a `password`
 * goes only into a password field; a `generic-secret` (an API key, a token,
 * any value from the environment) goes into any editable input.
 */
export type SecretPurpose = 'password' | 'generic-secret';

/** Opaque host-side value accepted only by sensitive input sinks. */
export interface Secret {
  readonly name: string;
  readonly purpose: SecretPurpose;
  readonly [secretBrand]: true;
}

/** Named test identity. The password remains an opaque Secret. */
export interface Credential {
  readonly name: string;
  readonly username: string;
  readonly password: Secret;
  readonly [credentialBrand]: true;
}

export interface Credentials {
  /** Resolves a named credential without exposing its password. */
  user(name: string): Credential;
}

export interface Secrets {
  /**
   * The opaque handle of a secret declared under `config.secrets`. Test code
   * cannot read the value; `locator.fill` and `agent.act` params accept the
   * handle and the runner fills the field itself.
   */
  get(name: string): Secret;
}

/**
 * Resolves a secret's plaintext at fill time — a vault lookup, a freshly
 * computed TOTP — instead of a value baked at config load. Called on every
 * fill after the full authorization policy passes; the resolved value goes
 * straight to the trusted driver, joins runner-side redaction, and is never
 * logged, cached, or sent to a model. Like executors and stores, a provider
 * never crosses a process boundary: workers re-resolve the config module.
 */
export type SecretProvider = () => string | Promise<string>;

/** One `config.credentials` entry: an account whose password is the secret of the entry's name. */
export interface CredentialConfig {
  username: string;
  password: string | SecretProvider;
  allowedOrigins?: readonly string[];
}

/** A `config.secrets` entry in its one full shape; a bare value or provider is shorthand for `{ value }`. */
export interface SecretDeclaration {
  value: string | SecretProvider;
  allowedOrigins?: readonly string[];
}

/**
 * One `config.secrets` entry: the value itself (or a provider computing it at
 * fill time), or an object narrowing the origins the secret may be filled on.
 */
export type SecretConfig = string | SecretProvider | SecretDeclaration;

/** Every `SecretConfig` as the full `{ value, allowedOrigins? }` shape. */
export function normalizeSecretConfig(entry: SecretConfig): SecretDeclaration {
  return typeof entry === 'object' ? entry : { value: entry };
}

/** A non-empty static value or a provider function; anything else is the caller's error to name. */
export function isSecretValue(value: unknown): value is string | SecretProvider {
  return (typeof value === 'string' && value !== '') || typeof value === 'function';
}

/** `E2E_USER_ADMIN`, `E2E_SECRET_STRIPE_KEY`: the name uppercased, everything outside A-Z0-9 as `_`. */
export function envName(prefix: 'E2E_USER' | 'E2E_SECRET', name: string): string {
  return `${prefix}_${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`;
}

const SECRET_DECLARATION_KEYS = new Set(['value', 'allowedOrigins']);

/**
 * Validates the object form of a `secrets` entry the way config resolution
 * validates every other block, so a mistake fails the run at load rather than
 * at the first fill: no unknown keys, and `allowedOrigins` a list of
 * serialized origins if present. The value itself is checked by the caller,
 * after the environment override.
 */
export function validateSecretDeclaration(where: string, declared: SecretDeclaration): void {
  for (const key of Object.keys(declared)) {
    if (!SECRET_DECLARATION_KEYS.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown ${where} key "${key}"${didYouMean(key, [...SECRET_DECLARATION_KEYS])}`,
      );
    }
  }
  validateAllowedOrigins(where, declared.allowedOrigins);
}

/** `allowedOrigins` on a credential or a secret: absent, or a list of serialized origins. */
export function validateAllowedOrigins(where: string, origins: unknown): void {
  if (origins === undefined) return;
  if (!Array.isArray(origins)) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} allowedOrigins must be an array`);
  }
  for (const origin of origins) {
    let parsed: URL | undefined;
    try {
      parsed = typeof origin === 'string' ? new URL(origin) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || parsed.origin !== origin) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where} allowedOrigins must hold serialized origins such as https://auth.example.com, got ${JSON.stringify(origin)}`,
      );
    }
  }
}

/**
 * Whether a secret may be filled on `origin`: the page must be on the app's
 * site, and the secret's own list, when declared, may name any origin, a
 * third-party sign-in page included. A target without a site (no URL) has no
 * page a redirect can steer to and admits every origin. One rule for the
 * agent's `type_secret` and a test's `locator.fill`.
 */
export function secretOriginAllowed(
  origin: string,
  site: string | undefined,
  secret: { readonly allowedOrigins: readonly string[] | undefined },
): boolean {
  if (secret.allowedOrigins !== undefined) return secret.allowedOrigins.includes(origin);
  return site === undefined || sameSite(origin, site);
}
