/** What one live session knows about secrets: the values to redact, and whether one reached it. */

import type { ResolvedConfig } from '../config/resolve.ts';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import type { TargetSession } from '../engine/surface.ts';
import { ConfigurationError, setErrorRedactor } from '../internal/errors.ts';
import { SecretLedger } from '../internal/redact.ts';
import { unavailableCode } from '../secrets.ts';
import type { Secret } from '../types.ts';

export interface SessionSecrecy {
  /** Every secret value the session may have seen; live, so a provider's value joins the moment it exists. */
  readonly ledger: SecretLedger;
  /** Whether a secret was filled into the session, and what that withholds. */
  readonly exposure: SecretExposure;
}

/**
 * Whether a secret was typed into one session's app. It only rises, and is
 * never cleared: `none`, nothing was filled; `filled`, a secret was typed
 * into the app.
 */
export type SecretExposureLevel = 'none' | 'filled';

/**
 * One session's exposure level, and the one place that maps it to what each
 * consumer withholds. Only a fill withholds pixels (failure screenshots,
 * `app.screenshot()`, assert evidence, and model input): a value that
 * reached the app otherwise (an engine option, a URL or a `fill` the test
 * spelled it into) is protected as text only, so a page that renders it on
 * screen is not masked. Only a fill
 * carries into a saved session too: the value then lives in the app's
 * state. Text is not decided here: see `redactsDownloads`.
 */
export class SecretExposure {
  private current: SecretExposureLevel = 'none';

  /** Records that a secret was filled into the session. */
  raise(level: Exclude<SecretExposureLevel, 'none'>): void {
    this.current = level;
  }

  /** Whether no pixels may leave the session: no screenshot or screencast frame is taken, kept, or handed to a model. */
  get withholdsPixels(): boolean {
    return this.current === 'filled';
  }

  /** Whether a session saved from this one carries the taint to the sessions that restore it. */
  get carriesTaint(): boolean {
    return this.current === 'filled';
  }
}

/**
 * Whether a text-like download of the session is rewritten through its
 * ledger before it is kept: whenever the ledger holds a value, filled or
 * not. A value reaches the app in ways the runner never sees (a URL or a
 * `fill` the test spelled it into, the app's own config), so downloads are
 * redacted like every report and observation, not only after a fill.
 */
export function redactsDownloads(secrecy: SessionSecrecy): boolean {
  return !secrecy.ledger.isEmpty;
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
export function staticSecretLedger(secrets: ResolvedConfig['allSecrets']): Pick<SecretLedger, 'redact' | 'entries'> {
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
const secrecyBySession = new WeakMap<TargetSession, SessionSecrecy>();

/**
 * The secrecy state of one session, created on first use and shared by every
 * attempt that borrows the session (a serial group's members). The ledger is
 * seeded with the static secret values known up front; provider-backed
 * values join through the resolver at fill time.
 */
export function sessionSecrecy(
  session: TargetSession,
  secrets: ResolvedConfig['allSecrets'],
): SessionSecrecy {
  let secrecy = secrecyBySession.get(session);
  if (secrecy === undefined) {
    registerStaticSecrets(secrets);
    secrecy = {
      ledger: new SecretLedger(staticSecretLedger(secrets).entries()),
      exposure: new SecretExposure(),
    };
    secrecyBySession.set(session, secrecy);
  }
  return secrecy;
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
  return (session === undefined ? staticSecretLedger(secrets) : sessionSecrecy(session, secrets).ledger).redact(text);
}

/** What a saved session carries of the secrecy of the attempt that saved it. */
export interface SavedSecrecy {
  /** Name and value pairs the saving session learned beyond the static config values; travels only inside the encrypted payload. */
  readonly secrets: readonly (readonly [string, string])[];
  /** Whether a secret was filled on the saving session, so its viewport, and any state restored from it, may carry one. */
  readonly tainted: boolean;
}

/**
 * The secrecy a session envelope carries: the provider-resolved values the
 * session learned, which the consumer's session cannot learn again on its
 * own, and the taint. Static config values are left out; every session
 * registers those itself.
 */
export function carriedSecrecy(
  secrecy: SessionSecrecy,
  secrets: ResolvedConfig['allSecrets'],
): SavedSecrecy {
  return {
    secrets: secrecy.ledger
      .entries()
      .filter(([name, value]) => secrets.get(name)?.value !== value),
    tainted: secrecy.exposure.carriesTaint,
  };
}

/** Seeds a restored session's secrecy with what the saving session knew, so a value the restored state echoes back is still redacted and withheld. */
export function adoptSecrecy(secrecy: SessionSecrecy, saved: SavedSecrecy): void {
  for (const [name, value] of saved.secrets) {
    secrecy.ledger.register(name, value);
    processSecrets.register(name, value);
  }
  if (saved.tainted) secrecy.exposure.raise('filled');
}
