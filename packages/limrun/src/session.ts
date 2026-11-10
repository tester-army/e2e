import { createHash } from 'node:crypto';

/**
 * The session the driver allocates a lease under and the heartbeat renews it under. agent-device
 * refuses a provider lease to a client that names no session, and the daemon in `stateDir` holds
 * one lease. The lease the engine receives never carries it: the engine names its own session.
 */
export function leaseSession(stateDir: string): string {
  return `e2e-lease-${createHash('sha256').update(stateDir).digest('hex').slice(0, 8)}`;
}
