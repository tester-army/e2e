import { createHash } from 'node:crypto';

/**
 * The session a lease's daemon allocates and renews the lease under. agent-device refuses a
 * provider lease to a client that names no session, and the daemon in `stateDir` holds one lease.
 */
export function leaseSession(stateDir: string): string {
  return `e2e-lease-${createHash('sha256').update(stateDir).digest('hex').slice(0, 8)}`;
}
