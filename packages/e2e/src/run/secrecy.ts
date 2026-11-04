/** What one live session knows about secrets: the values to redact. */

import type { ResolvedConfig } from '../config/resolve.ts';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import type { TargetSession } from '../engine/surface.ts';
import { ConfigurationError, setErrorRedactor } from '../internal/errors.ts';
import { SecretLedger } from '../internal/redact.ts';
import { unavailableCode } from '../secrets.ts';
import type { Secret } from '../types.ts';

/**
 * Whether captured pixels are proven redacted: the engine masked at least as
 * many regions as the secure nodes it observed. Pixels that are not leave no
 * session, whoever asked for them.
 */
export function pixelsProvenMasked(redaction: { readonly secureNodeCount: number; readonly maskedRegionCount: number }): boolean {
  return redaction.maskedRegionCount >= redaction.secureNodeCount;
}

/**
 * Whether a text-like download of the session is rewritten through its
 * ledger before it is kept: whenever the ledger holds a value. A value
 * reaches the app in ways the runner never sees (a URL or a `fill` the test
 * spelled it into, the app's own config), so downloads are redacted like
 * every report and observation, not only after a fill.
 */
export function redactsDownloads(ledger: SecretLedger): boolean {
  return !ledger.isEmpty;
}

/**
 * Every secret value any session in this process has seen, for text the
 * process itself emits rather than a session: a test's console output leaves
 * the worker through here. Seeded with the static values as each session
 * learns them; provider-backed values join as they resolve.
 */
export const processSecrets = new SecretLedger();

/** The static ledger of each secrets map, built once. */
const staticLedgers = new WeakMap<ResolvedConfig['allSecrets'], SecretLedger>();

/**
 * A ledger of the static values of `secrets` alone, built once per map. What
 * text produced before any session exists is redacted with, such as a test
 * title at collection: every process resolving the same config redacts it
 * alike, so a test's id agrees between the runner and its workers. A
 * provider-backed value is not known yet and is not in it. Shared, so it is
 * handed out read-only: nothing registers into it.
 */
export function staticSecretLedger(secrets: ResolvedConfig['allSecrets']): Pick<SecretLedger, 'redact' | 'entries' | 'redactFragments'> {
  let ledger = staticLedgers.get(secrets);
  if (ledger === undefined) {
    ledger = new SecretLedger(
      [...secrets].flatMap(([name, { value }]) => (typeof value === 'string' ? [[name, value] as const] : [])),
    );
    staticLedgers.set(secrets, ledger);
  }
  return ledger;
}

/** Seeds `processSecrets` with the static values of `secrets` and makes it `serializeError`'s default redactor, so output before any session opens is covered too. */
export function registerStaticSecrets(secrets: ResolvedConfig['allSecrets']): void {
  setErrorRedactor(processSecrets.redact);
  for (const [name, { value }] of secrets) {
    if (typeof value === 'string') processSecrets.register(name, value);
  }
}

/**
 * The plaintext of one configured secret, a provider's value computed fresh.
 * The value joins `ledger` and `processSecrets` before it is returned, so it
 * is redacted from the moment it exists, whoever it is handed to.
 */
export async function resolveSecretValue(
  secret: Secret,
  secrets: ResolvedConfig['allSecrets'],
  ledger: SecretLedger,
): Promise<string> {
  const registered = secrets.get(secret.name);
  if (registered === undefined) {
    throw new ConfigurationError(unavailableCode(secret), `secret "${secret.name}" is not configured`);
  }
  const value = registered.value;
  const plaintext = typeof value === 'function' ? await value() : value;
  if (typeof plaintext !== 'string' || secretLength(plaintext) < MIN_SECRET_LENGTH) {
    throw new ConfigurationError(
      unavailableCode(secret),
      `secret "${secret.name}" provider did not return a string of at least ${MIN_SECRET_LENGTH} characters (code points)`,
    );
  }
  ledger.register(secret.name, plaintext);
  processSecrets.register(secret.name, plaintext);
  return plaintext;
}

/**
 * Registers the forms an engine derived from one resolved secret (the base64
 * basic-auth credential) under the secret's name, in `ledger` and in
 * `processSecrets`, so what the app sees in place of the value is redacted
 * wherever the value is. Registered before the engine hands a form to the
 * app, since the resolve that computes them has not returned yet.
 */
export function registerDerivedSecrets(name: string, derived: readonly string[], ledger: SecretLedger): void {
  for (const value of derived) {
    if (typeof value !== 'string' || value === '') continue;
    ledger.register(name, value);
    processSecrets.register(name, value);
  }
}

/** Secrets survive every fixture graph that shares the same live isolation. */
const ledgerBySession = new WeakMap<TargetSession, SecretLedger>();

/**
 * Every secret value one session may have seen, created on first use and
 * shared by every attempt that borrows the session (a serial group's
 * members). Seeded with the static secret values known up front;
 * provider-backed values join through the resolver the moment they exist.
 */
export function sessionLedger(
  session: TargetSession,
  secrets: ResolvedConfig['allSecrets'],
): SecretLedger {
  let ledger = ledgerBySession.get(session);
  if (ledger === undefined) {
    registerStaticSecrets(secrets);
    ledger = new SecretLedger(staticSecretLedger(secrets).entries());
    ledgerBySession.set(session, ledger);
  }
  return ledger;
}

/**
 * Redacts `text` with every value `session` has seen, or with the static
 * values while no session is open yet, so text an attempt produces before
 * its session exists (a step label, a fixture error) is covered too.
 */
export function redactForSession(
  session: TargetSession | undefined,
  secrets: ResolvedConfig['allSecrets'],
  text: string,
): string {
  return (session === undefined ? staticSecretLedger(secrets) : sessionLedger(session, secrets)).redact(text);
}

/** Name and value pairs a saved session carries beyond the static config values; they travel only inside the encrypted payload. */
export type SavedSecrets = readonly (readonly [string, string])[];

/**
 * The values a session envelope carries: the provider-resolved values the
 * session learned, which the consumer's session cannot learn again on its
 * own. Static config values are left out; every session registers those
 * itself.
 */
export function carriedSecrets(ledger: SecretLedger, secrets: ResolvedConfig['allSecrets']): SavedSecrets {
  return ledger.entries().filter(([name, value]) => secrets.get(name)?.value !== value);
}

/** Seeds a restored session's ledger with what the saving session knew, so a value the restored state echoes back is still redacted. */
export function adoptSecrets(ledger: SecretLedger, saved: SavedSecrets): void {
  for (const [name, value] of saved) {
    ledger.register(name, value);
    processSecrets.register(name, value);
  }
}
