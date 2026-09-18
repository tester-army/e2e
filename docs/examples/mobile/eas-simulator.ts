import type { DeviceLease, DeviceProvider, DeviceRequest } from '@e2edev/agent-device';

const API = 'https://api.expo.dev/v2/device-run-sessions';

interface Session {
  id: string;
  status: string;
  remoteConfig: {
    agentDeviceRemoteSessionUrl: string;
    agentDeviceRemoteSessionToken?: string;
    webPreviewUrl?: string;
  } | null;
}

async function expo<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok) throw new Error(`EAS Simulator ${init.method ?? 'GET'} ${path}: HTTP ${response.status}`);
  return ((await response.json()) as { data: T }).data;
}

/** Leases one EAS Simulator session per worker slot, with the given EAS build installed. */
export function easSimulator(options: { appId: string; buildId: string; device?: string }): DeviceProvider {
  const token = (env: DeviceRequest['env']): string => {
    const value = env['EXPO_TOKEN'];
    if (value === undefined || value === '') throw new Error('EXPO_TOKEN is not set');
    return value;
  };
  return {
    name: 'eas-simulator',
    async acquire(request) {
      const created = await expo<Session>(token(request.env), '', {
        method: 'POST',
        body: JSON.stringify({
          appId: options.appId,
          platform: request.platform,
          type: 'agent-device',
          buildId: options.buildId,
          name: `${request.runId} ${request.targetName} ${request.slot + 1}/${request.slots}`,
          ...(options.device === undefined ? {} : { deviceIdentifier: options.device }),
        }),
      });
      let session = created;
      while (session.status === 'new' || session.remoteConfig === null) {
        if (session.status !== 'new' && session.status !== 'in-progress') {
          throw new Error(`EAS Simulator session ${session.id} is ${session.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        if (request.signal.aborted) throw new Error('interrupted while the simulator was starting');
        session = await expo<Session>(token(request.env), `/${session.id}`);
      }
      const { agentDeviceRemoteSessionUrl, agentDeviceRemoteSessionToken, webPreviewUrl } = session.remoteConfig;
      if (webPreviewUrl !== undefined) request.log(`watch at ${webPreviewUrl}`);
      return { id: session.id, daemon: { baseUrl: agentDeviceRemoteSessionUrl, authToken: agentDeviceRemoteSessionToken } };
    },
    async release(lease: DeviceLease, context) {
      await expo(token(context.env), `/${lease.id}/stop`, { method: 'POST' });
    },
  };
}
