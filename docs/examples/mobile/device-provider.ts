import type { DeviceProvider } from '@e2e-dev/mobile';

/**
 * Leases devices from a service that starts an agent-device daemon per
 * session. Replace the three requests with your service's API.
 */
export function hostedDevices(options: { serviceUrl: string; image: string }): DeviceProvider {
  return {
    name: 'hosted-devices',
    async acquire(request) {
      const token = request.env['DEVICE_SERVICE_TOKEN'];
      if (token === undefined || token === '') throw new Error('DEVICE_SERVICE_TOKEN is not set');
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      // 1. Ask for a device; name the session after the run so it can be found later.
      const created = await fetch(`${options.serviceUrl}/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          platform: request.platform,
          image: options.image,
          name: `e2e ${request.runId} ${request.targetName} ${request.slot + 1}/${request.slots}`,
        }),
        signal: request.signal,
      });
      if (!created.ok) throw new Error(`device service: HTTP ${created.status}`);
      const { id } = (await created.json()) as { id: string };
      // 2. Wait until the session exposes its agent-device daemon.
      for (;;) {
        const response = await fetch(`${options.serviceUrl}/sessions/${id}`, { headers, signal: request.signal });
        const session = (await response.json()) as { status: string; daemonUrl?: string; daemonToken?: string; viewerUrl?: string };
        if (session.status === 'ready' && session.daemonUrl !== undefined) {
          if (session.viewerUrl !== undefined) request.log(`watch at ${session.viewerUrl}`);
          return { id, daemon: { baseUrl: session.daemonUrl, authToken: session.daemonToken } };
        }
        if (session.status !== 'starting') throw new Error(`device service: session ${id} is ${session.status}`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    },
    async release(lease, context) {
      // 3. Stop the session; the run waits for this within cleanupTimeout.
      const token = context.env['DEVICE_SERVICE_TOKEN'] ?? '';
      await fetch(`${options.serviceUrl}/sessions/${lease.id}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: context.signal,
      });
    },
  };
}
