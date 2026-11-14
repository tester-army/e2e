/**
 * Secret and credential declarations: the public types a test or config
 * spells, and the rules that read them (the env-variable name a declaration
 * answers to, what counts as a value). `types.ts` re-exports the types;
 * `resolve.ts` and the handle module apply the rules.
 */

import type { credentialBrand, secretBrand } from '../internal/brands.ts';

/**
 * What a secret is for, which decides where it may be filled: a `password`
 * goes only into a password field; a `generic-secret` (an API key, a token,
 * any value from the environment) goes into any editable input.
 */
export type SecretPurpose = 'password' | 'generic-secret';

/** Opaque host-side value accepted only by sensitive input sinks. */
export interface Secret {
  /** The entry's name in `secrets`, or `<credential>.password` for a credential's password. */
  readonly name: string;
  /** Where the value may be filled. */
  readonly purpose: SecretPurpose;
  readonly [secretBrand]: true;
}

/** Named test identity. The password remains an opaque Secret. */
export interface Credential {
  /** The entry's name in `credentials`. */
  readonly name: string;
  /** Plain username. */
  readonly username: string;
  /** Opaque; test code cannot read it. */
  readonly password: Secret;
  readonly [credentialBrand]: true;
}

export interface Credentials {
  /** Resolves a named credential without exposing its password. */
  user(name: string): Credential;
}

export interface Secrets {
  /**
   * The opaque handle of a secret declared under `config.secrets`. A
   * credential's password is not one of them: it is
   * `credentials.user(name).password`. Test code cannot read
   * the value; `locator.fill` and `agent.act` params accept the handle and
   * the runner fills the field itself. Called while `e2e.config.ts`
   * evaluates, it returns a reference by name for an engine option such as
   * `web({ basicAuth: { password } })`, resolved when the engine starts an
   * attempt; a name no secret has fails the config load with `INVALID_CONFIG`.
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

/**
 * The name of a credential's password handle: `admin.password`. Credentials
 * and secrets are separate namespaces, but the agent, the replay cache, and
 * the reports know a secret by its name alone, so a password is named for its
 * credential and field.
 */
export function credentialSecretName(credential: string): string {
  return `${credential}.password`;
}

/**
 * The credential a `secrets.get(name)` that names no `secrets` entry most
 * likely meant: the one named `name`, or the one whose password `name` is.
 * The config load and a running test both name it in their error.
 */
export function credentialNamed<C extends { readonly name: string; readonly password: { readonly name: string } }>(
  name: string,
  credentials: ReadonlyMap<string, C>,
): C | undefined {
  return [...credentials.values()].find((credential) => credential.name === name || credential.password.name === name);
}

/** One `config.credentials` entry: an account whose password is a secret named `<entry>.password`. */
export interface CredentialConfig {
  username: string;
  password: string | SecretProvider;
}

/** One `config.secrets` entry: the value itself, or a provider computing it at fill time. */
export type SecretConfig = string | SecretProvider;

/**
 * The fewest characters, counted as code points, a static secret value may
 * have. Redaction rewrites every occurrence of a value, so a shorter one (a
 * PIN, a port number) would take ordinary text in reports and output with it.
 */
export const MIN_SECRET_LENGTH = 6;

/** A value's length as a reader counts it: in code points, so an emoji is one character, not two. */
export function secretLength(value: string): number {
  return [...value].length;
}

/** A static value of at least `MIN_SECRET_LENGTH` code points or a provider function; anything else is the caller's error to name. */
export function isSecretValue(value: unknown): value is string | SecretProvider {
  return (typeof value === 'string' && secretLength(value) >= MIN_SECRET_LENGTH) || typeof value === 'function';
}

/** Which rule a value `isSecretValue` refused broke, for the `INVALID_CONFIG` message that names it. */
export function secretValueProblem(value: unknown): string {
  return typeof value === 'string' && value !== ''
    ? `must be at least ${MIN_SECRET_LENGTH} characters (code points), not ${secretLength(value)}; a shorter value cannot be redacted without rewriting unrelated text`
    : 'must be a non-empty string or a provider function';
}

/** `E2E_USER_ADMIN`, `E2E_SECRET_STRIPE_KEY`: the name uppercased, everything outside A-Z0-9 as `_`. */
export function envName(prefix: 'E2E_USER' | 'E2E_SECRET', name: string): string {
  return `${prefix}_${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`;
}

