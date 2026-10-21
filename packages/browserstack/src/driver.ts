import { createAgentDeviceClient, type LeaseAllocateOptions } from 'agent-device';

/** A separate process gives each daemon its own credentials and plugin home without changing the runner's environment. */
export interface DriverRequest {
  stateDir: string;
  allocate: LeaseAllocateOptions;
}

export interface DriverGrant {
  leaseId: string;
  tenantId: string;
  runId: string;
  retainOnClose: boolean;
}

process.once('message', (request: DriverRequest) => {
  void allocate(request).then(
    (grant) => process.send?.({ grant }, () => process.disconnect?.()),
    (cause: unknown) => process.send?.({ error: cause instanceof Error ? cause.message : String(cause) }, () => process.disconnect?.()),
  );
});

async function allocate({ stateDir, allocate: options }: DriverRequest): Promise<DriverGrant> {
  const lease = await createAgentDeviceClient({ stateDir }).leases.allocate(options);
  return { leaseId: lease.leaseId, tenantId: lease.tenantId, runId: lease.runId, retainOnClose: lease.retainOnClose === true };
}
