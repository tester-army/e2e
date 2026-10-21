import { createAgentDeviceClient, type LeaseScopedOptions } from 'agent-device';

export const LEASE_TTL_MS = 60_000;

/** Renew idle leases while other targets run; session retention alone does not prevent expiry. */
export async function startHeartbeat(stateDir: string, scope: LeaseScopedOptions, log: (line: string) => void): Promise<() => Promise<void>> {
  // An explicit empty URL selects the local stateDir instead of an ambient remote daemon.
  const client = createAgentDeviceClient({ stateDir, daemonBaseUrl: '', daemonAuthToken: '', daemonTransport: 'auto' });
  const controller = new AbortController();
  const beat = () => client.leases.heartbeat({ ...scope, ttlMs: LEASE_TTL_MS, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
  await beat();
  let pending: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout;
  const schedule = () => {
    timer = setTimeout(() => {
      pending = beat().then(() => {}, (error: unknown) => {
        if (controller.signal.aborted) return;
        try {
          log(`lease ${scope.leaseId}: renewal failed: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // The run's log may be closed by now.
        }
      }).finally(() => { if (!controller.signal.aborted) schedule(); });
    }, 20_000);
    timer.unref();
  };
  schedule();
  return async () => {
    controller.abort();
    clearTimeout(timer);
    await pending;
  };
}
