import { createAgentDeviceClient } from 'agent-device';
import type { DriverBinding } from './driver.ts';

/** Renew idle leases while other targets run; session retention alone does not prevent expiry. */
export async function startHeartbeat(binding: DriverBinding, log: (line: string) => void): Promise<() => Promise<void>> {
  // An explicit empty URL selects the local stateDir instead of an ambient remote daemon.
  const client = createAgentDeviceClient({ ...binding.client, daemonBaseUrl: '', daemonAuthToken: '', daemonTransport: 'auto' });
  const leaseId = binding.client.leaseId;
  if (!leaseId) throw new Error('Limrun driver returned no agent-device lease id');
  const controller = new AbortController();
  const beat = () => client.leases.heartbeat({ leaseId, ttlMs: 60_000, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
  await beat();
  let pending: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout;
  const schedule = () => {
    timer = setTimeout(() => {
      pending = beat().then(() => {}, (error: unknown) => {
        if (!controller.signal.aborted) log(`driver lease renewal failed: ${error instanceof Error ? error.message : String(error)}`);
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
