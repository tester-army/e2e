/** What one live session knows about secrets: the values to redact, and whether one reached it. */

import type { ResolvedConfig } from '../config/resolve.ts';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import type { TargetSession } from '../engine/surface.ts';
import { ConfigurationError, setErrorRedactor } from '../internal/errors.ts';
import { withTimeout } from '../internal/time.ts';
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
 * Whether captured pixels are proven redacted: the engine masked at least as
 * many regions as the secure nodes it observed. Pixels that are not leave no
 * session, whoever asked for them.
 */
export function pixelsProvenMasked(redaction: { readonly secureNodeCount: number; readonly maskedRegionCount: number }): boolean {
  return redaction.maskedRegionCount >= redaction.secureNodeCount;
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
      [...secrets].flatMap(([name, secret]) => {
        const value = literalSecretValue(secret);
        return value === undefined ? [] : [[name, value] as const];
      }),
    );
    staticLedgers.set(secrets, ledger);
  }
  return ledger;
}

/** Seeds `processSecrets` with the static values of `secrets` and makes it `serializeError`'s default redactor, so output before any session opens is covered too. */
export function registerStaticSecrets(secrets: ResolvedConfig['allSecrets']): void {
  setErrorRedactor(processSecrets.redact);
  for (const [name, secret] of secrets) {
    const value = literalSecretValue(secret);
    if (value !== undefined) processSecrets.register(name, value);
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
  derived?: (plaintext: string) => readonly string[],
): Promise<string> {
  configureSecretResolutions(ledger, secrets);
  const registered = secrets.get(secret.name);
  if (registered === undefined) {
    resolutions(ledger).failed = true;
    throw new ConfigurationError(unavailableCode(secret), `secret "${secret.name}" is not configured`);
  }
  const state = resolutions(ledger);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  state.pending.add(pending);
  try {
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
    // An engine's derived forms join before its resolution is proven complete.
    registerDerivedSecrets(secret.name, derived?.(plaintext) ?? [], ledger);
    return plaintext;
  } catch (cause) {
    state.failed = true;
    throw cause;
  } finally {
    state.pending.delete(pending);
    finish();
  }
}

/** Private resolution and effective-definition accounting, never a raw-text buffer. */
const resolutionsByLedger = new WeakMap<SecretLedger, { pending: Set<Promise<void>>; failed: boolean; configured: boolean; opaque: boolean }>();

/** Shares accounting between bound definitions and actual calls, without invoking providers. */
function resolutions(ledger: SecretLedger) {
  let state = resolutionsByLedger.get(ledger);
  if (state === undefined) {
    state = { pending: new Set(), failed: false, configured: false, opaque: false };
    resolutionsByLedger.set(ledger, state);
  }
  return state;
}

/** Reads only an own data descriptor; accessor-backed references remain opaque. */
function literalSecretValue(secret: unknown): string | undefined {
  if (typeof secret !== 'object' || secret === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(secret, 'value');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

/** Classifies effective private definitions using own descriptors, never evaluating a lazy value. */
export function hasOpaqueSecretDefinitions(secrets: ResolvedConfig['allSecrets']): boolean {
  return [...secrets.values()].some((secret) => literalSecretValue(secret) === undefined);
}

/** Monotonic effective-layer accounting; seeds EVERY literal before any handoff. */
function configureSecretResolutions(ledger: SecretLedger, secrets: ResolvedConfig['allSecrets']): void {
  const state = resolutions(ledger);
  state.configured = true;
  for (const [name, secret] of secrets) {
    const value = literalSecretValue(secret);
    if (value === undefined) state.opaque = true;
    else {
      ledger.register(name, value);
      processSecrets.register(name, value);
    }
  }
}

/** A failed or still-running resolver cannot prove that every value reached the ledger. */
export function secretResolutionsProven(ledger: SecretLedger): boolean {
  const state = resolutionsByLedger.get(ledger);
  return state === undefined || (!state.failed && state.pending.size === 0);
}

/**
 * Prospective content proof for first publication, not just the pending queue.
 * Opaque providers or lazy values permanently deny content proof. SDK facts
 * permit only fixed protocol reasons and SDK-minted boundaries, never prose,
 * pixels or engine metadata. Missing configuration denies both cases.
 * This predicate never invokes getters, providers, waits or model work.
 */
export function prospectiveSecretResolutionsProven(ledger: SecretLedger, evidence: 'content' | 'sdk-facts' = 'content'): boolean {
  const state = resolutionsByLedger.get(ledger);
  return state?.configured === true && (evidence === 'sdk-facts' || !state.opaque && secretResolutionsProven(ledger));
}

/** Private compatibility name for prospective CONTENT proof only. */
export function secretPublicationProven(ledger: SecretLedger): boolean {
  return prospectiveSecretResolutionsProven(ledger);
}

/** Drains actual resolutions within the caller's remaining budget, never a fresh deadline. */
export async function settleSecretResolutions(ledger: SecretLedger, remainingMs: number): Promise<boolean> {
  if (secretResolutionsProven(ledger)) return true;
  if (remainingMs <= 0) return false;
  const deadline = Date.now() + remainingMs;
  const state = resolutions(ledger);
  try {
    while (state.pending.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await withTimeout(Promise.all(state.pending), left, () => new Error('secret resolution did not settle'));
    }
  } catch { return false; }
  return secretResolutionsProven(ledger);
}

/**
 * Registers the forms an engine derived from one resolved secret (the base64
 * basic-auth credential) under the secret's name, in `ledger` and in
 * `processSecrets`, so what the app sees in place of the value is redacted
 * wherever the value is. Registered before the engine hands a form to the
 * app, since the resolve that computes them has not returned yet.
 */
function registerDerivedSecrets(name: string, derived: readonly string[], ledger: SecretLedger): void {
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
    secrecy = {
      ledger: new SecretLedger(staticSecretLedger(secrets).entries()),
      exposure: new SecretExposure(),
    };
    secrecyBySession.set(session, secrecy);
  }
  registerStaticSecrets(secrets);
  configureSecretResolutions(secrecy.ledger, secrets);
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
      .filter(([name, value]) => literalSecretValue(secrets.get(name)) !== value),
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
