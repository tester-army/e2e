import type { DeviceProvider } from '@e2e-dev/mobile';
import { agentDeviceLeases } from '@e2e-dev/mobile/lease';

/**
 * Leases devices from a device cloud agent-device itself speaks to. Each
 * worker slot gets its own agent-device daemon, whose runtime for the cloud
 * starts the session when the lease is allocated and ends it on release.
 * `provider` is agent-device's name for the cloud.
 */
export function cloudDevices(options: { provider: string; device: string; osVersion: string; app: string }): DeviceProvider {
  const leases = agentDeviceLeases({ provider: options.provider, label: options.provider });
  return {
    name: options.provider,
    async acquire(request) {
      const token = request.env['CLOUD_TOKEN'];
      if (token === undefined || token === '') throw new Error('CLOUD_TOKEN is not set');
      return leases.acquire(request, {
        // The daemon's runtime reads the credentials from its environment.
        env: { CLOUD_TOKEN: token },
        selectors: { device: options.device, providerOsVersion: options.osVersion, providerApp: options.app },
        summary: `${options.device}, ${request.platform} ${options.osVersion}`,
      });
    },
    release: (lease, context) => leases.release(lease, context),
  };
}
