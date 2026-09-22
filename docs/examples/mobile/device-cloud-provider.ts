import { createAgentDeviceClient } from 'agent-device';
import type { DeviceProvider } from '@e2edev/mobile';

/**
 * Leases devices from a device cloud agent-device itself speaks to, through
 * a daemon started for the run. The daemon's runtime for the cloud creates
 * the instance when the lease is allocated and deletes it when the lease is
 * released; the worker's client carries the lease, so every command lands on
 * that instance. `provider` is agent-device's name for the cloud; its runtime
 * reads the credentials from the environment the daemon starts with.
 */
export function cloudDevices(options: { provider: string; stateDir: string }): DeviceProvider {
  const scopes = new Map<string, { tenant: string; runId: string; leaseId: string; leaseBackend: 'ios-instance' | 'android-instance'; leaseProvider: string }>();
  return {
    name: options.provider,
    async acquire(request) {
      // One daemon per run, under a directory of its own.
      const stateDir = `${options.stateDir}/${request.runId}`;
      const client = createAgentDeviceClient({ stateDir, session: `lease-${request.slot}` });
      const leaseBackend = request.platform === 'ios' ? ('ios-instance' as const) : ('android-instance' as const);
      const lease = await client.leases.allocate({
        tenant: options.provider,
        runId: request.runId,
        leaseBackend,
        leaseProvider: options.provider,
        platform: request.platform,
        target: 'mobile',
      });
      request.log(`leased ${lease.leaseId}`);
      const scope = { tenant: lease.tenantId, runId: lease.runId, leaseId: lease.leaseId, leaseBackend, leaseProvider: options.provider };
      scopes.set(lease.leaseId, scope);
      // The worker's client is created with these fields; the daemon resolves the device from them.
      return { id: lease.leaseId, client: { stateDir, ...scope } };
    },
    async release(lease) {
      const scope = scopes.get(lease.id);
      if (scope === undefined) return;
      const client = createAgentDeviceClient({ stateDir: `${options.stateDir}/${scope.runId}`, session: 'release' });
      await client.leases.release(scope);
    },
  };
}
