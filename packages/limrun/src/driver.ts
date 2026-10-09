import { createAgentDeviceClient, type AgentDeviceClientConfig } from 'agent-device';

/** A separate process gives each daemon its own credentials without changing the runner's environment. */
export interface DriverRequest {
  stateDir: string;
  runId: string;
  slot: number;
  platform: 'ios' | 'android';
  app?: string | undefined;
  appPath?: string | undefined;
}

export interface DriverBinding {
  client: AgentDeviceClientConfig;
  deviceId: string;
  installedApp?: string;
}

process.once('message', (request: DriverRequest) => {
  void attach(request).then(
    (binding) => process.send?.({ binding }, () => process.disconnect?.()),
    (cause: unknown) => process.send?.({ error: cause instanceof Error ? cause.message : String(cause) }, () => process.disconnect?.()),
  );
});

async function attach(request: DriverRequest): Promise<DriverBinding> {
  const { stateDir, runId, slot, platform, app, appPath } = request;
  const allocator = createAgentDeviceClient({ stateDir });
  const lease = await allocator.leases.allocate({
    tenant: 'e2e', runId, clientId: `worker-${slot}`, leaseBackend: `${platform}-instance`, leaseProvider: 'limrun', retainOnClose: true,
  });
  if (!lease.retainOnClose) throw new Error('agent-device did not retain the Limrun lease across session close');
  const client: AgentDeviceClientConfig = {
    stateDir, tenant: lease.tenantId, runId: lease.runId, leaseId: lease.leaseId,
    leaseBackend: lease.backend, leaseProvider: 'limrun',
    ...(lease.deviceKey === undefined ? {} : { deviceKey: lease.deviceKey }),
    ...(lease.clientId === undefined ? {} : { clientId: lease.clientId }),
  };
  const binding: DriverBinding = { client, deviceId: `limrun:${platform}:${lease.leaseId}` };
  if (appPath !== undefined) {
    const device = createAgentDeviceClient(client);
    const installed = await device.apps.install({ appPath, ...(platform === 'ios' ? { udid: binding.deviceId } : { serial: binding.deviceId }), ...(app === undefined ? {} : { app }), platform });
    const id = installed.appId ?? installed.bundleId ?? installed.package ?? app;
    if (!id) throw new Error('Limrun installed the build but agent-device returned no app identifier');
    binding.installedApp = id;
  }
  return binding;
}
