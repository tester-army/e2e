/** What one live session knows about secrets: the values to redact, and whether one reached it. */

import type { ResolvedConfig } from '../config/resolve.ts';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import type { TargetSession } from '../engine/surface.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { SecretLedger } from '../internal/redact.ts';
import { unavailableCode } from '../secrets.ts';
import type { Secret } from '../types.ts';

export interface SessionSecrecy {
  /** Every secret value the session may have seen; live, so a provider's value joins the moment it exists. */
  readonly ledger: SecretLedger;
  /** How far a secret reached the session, and what that withholds and rewrites. */
  readonly exposure: SecretExposure;
}

/**
 * How far a secret reached one session. It only rises, and is never cleared:
 * `none`, no secret reached it; `engine`, the engine resolved one for an
 * option it hands the app (basic-auth credentials), so the app has the value
 * and a page can render it (an echo of the `Authorization` header) though
 * nothing was typed; `filled`, a secret was typed into the app.
 */
export type SecretExposureLevel = 'none' | 'engine' | 'filled';

const EXPOSURE_RANK: Readonly<Record<SecretExposureLevel, number>> = { none: 0, engine: 1, filled: 2 };

/**
 * One session's exposure level, and the one place that maps it to what each
 * consumer does. Either level above `none` rewrites what text can carry the
 * value (a trace's text entries, a text-like download) through the ledger,
 * as every report and observation already is. Only a fill withholds pixels
 * (failure screenshots, `app.screenshot()`, assert evidence, model input,
 * and a trace's screencast frames): an engine-held secret is protected as
 * text only, so a page that renders it on screen is not masked. Only a fill
 * carries into a saved session too: the value then lives in the app's
 * state, while an engine-held one is resolved again by whatever engine opens
 * the restoring session.
 */
export class SecretExposure {
  private current: SecretExposureLevel = 'none';

  /** Records that a secret reached the session at `level`; a lower level never replaces a higher one. */
  raise(level: Exclude<SecretExposureLevel, 'none'>): void {
    if (EXPOSURE_RANK[level] > EXPOSURE_RANK[this.current]) this.current = level;
  }

  /** Whether no pixels may leave the session: no screenshot or screencast frame is taken, kept, or handed to a model. */
  get withholdsPixels(): boolean {
    return this.current === 'filled';
  }

  /** Whether a text recording of the session (a trace, a text-like download) is rewritten through the ledger before it is kept. */
  get redactsRecordings(): boolean {
    return this.current !== 'none';
  }

  /** Whether a session saved from this one carries the taint to the sessions that restore it. */
  get carriesTaint(): boolean {
    return this.current === 'filled';
  }
}

/**
 * Every secret value any session in this process has seen, for text the
 * process itself emits rather than a session: a test's console output leaves
 * the worker through here. Seeded with the static values as each session
 * learns them; provider-backed values join as they resolve.
 */
export const processSecrets = new SecretLedger();

/** Seeds `processSecrets` with the static values of `secrets`, so output before any session opens is covered too. */
export function registerStaticSecrets(secrets: ResolvedConfig['allSecrets']): void {
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
      ledger: new SecretLedger(
        [...secrets].flatMap(([name, { value }]) =>
          typeof value === 'string' ? [[name, value] as const] : [],
        ),
      ),
      exposure: new SecretExposure(),
    };
    secrecyBySession.set(session, secrecy);
  }
  return secrecy;
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
