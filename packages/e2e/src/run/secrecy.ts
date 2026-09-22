/** What one live session knows about secrets: the values to redact, and whether one reached it. */

import type { ResolvedConfig } from '../config/resolve.ts';
import type { TargetSession } from '../engine/surface.ts';
import { SecretLedger } from '../internal/redact.ts';

export interface SessionSecrecy {
  /** Every secret value the session may have seen; live, so a provider's value joins the moment it exists. */
  readonly ledger: SecretLedger;
  /**
   * Set the moment a secret is filled on the session, and never cleared: from
   * then on the viewport, and everything recorded from it, may carry the value.
   */
  readonly taint: { value: boolean };
}

/**
 * Every secret value any session in this process has seen, for text the
 * process itself emits rather than a session: a test's console output leaves
 * the worker through here. Seeded with the static values as each session
 * learns them; provider-backed values join as they resolve.
 */
export const processSecrets = new SecretLedger();

/** Seeds `processSecrets` with the static values of `secrets`, so output before any session opens is covered too. */
export function registerStaticSecrets(secrets: ResolvedConfig['secrets']): void {
  for (const [name, { value }] of secrets) {
    if (typeof value === 'string') processSecrets.register(name, value);
  }
}

/**
 * Registers a value an engine put on the wire or restored into the app (an
 * injected header, a basic-auth password, a session cookie) with the
 * session's ledger and the process ledger, under a name restricted to the
 * alphabet secret names share so it reads as one in `<secret:name>`. An empty
 * value registers nothing.
 */
export function registerEngineSecret(secrecy: SessionSecrecy, name: string, value: string): void {
  if (value === '') return;
  const clean = name.replaceAll(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'engine';
  secrecy.ledger.register(clean, value);
  processSecrets.register(clean, value);
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
  secrets: ResolvedConfig['secrets'],
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
      taint: { value: false },
    };
    secrecyBySession.set(session, secrecy);
  }
  return secrecy;
}
