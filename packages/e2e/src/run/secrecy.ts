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
