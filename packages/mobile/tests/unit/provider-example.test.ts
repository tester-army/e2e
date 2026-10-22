import { beforeEach, expect, it, vi } from 'vitest';
import type { DeviceProvider, DeviceRequest } from '../../src/provider.ts';

// Load the executable docs without including them in the mobile package's rootDir.
const exampleModule = new URL('../../../../docs/examples/mobile/device-cloud-provider.ts', import.meta.url).href;
const sdk = { allocate: vi.fn(), release: vi.fn() };
// Docs and mobile can resolve different pnpm peer instances of agent-device.
vi.doMock('../../../../docs/node_modules/agent-device', () => ({
  createAgentDeviceClient: vi.fn(() => ({ leases: sdk })),
}));
const { cloudDevices } = (await import(exampleModule)) as {
  cloudDevices: (options: { provider: string; stateDir: string }) => DeviceProvider;
};

const request: DeviceRequest = {
  platform: 'ios',
  runId: 'run-1',
  targetName: 'ios',
  slot: 0,
  slots: 1,
  agentDeviceVersion: '0.21.28',
  projectRoot: '/project',
  env: {},
  signal: new AbortController().signal,
  log: () => undefined,
};
const grant = { tenantId: 'allocated-tenant', runId: 'run-1', leaseId: 'allocated-lease' };
const scope = {
  tenant: grant.tenantId,
  runId: grant.runId,
  leaseId: grant.leaseId,
  leaseBackend: 'ios-instance',
  leaseProvider: 'cloud',
};
const releaseContext = { ...request };

beforeEach(() => {
  vi.clearAllMocks();
  sdk.release.mockResolvedValue({});
});

it('hands a retained cloud grant to the worker and releases the allocated scope', async () => {
  sdk.allocate.mockResolvedValue({ ...grant, retainOnClose: true });
  const cloud = cloudDevices({ provider: 'cloud', stateDir: '/state' });
  const lease = await cloud.acquire(request);

  expect(sdk.allocate).toHaveBeenCalledWith({
    tenant: 'cloud', runId: request.runId, leaseBackend: 'ios-instance',
    leaseProvider: 'cloud', retainOnClose: true, platform: 'ios', target: 'mobile',
  });
  expect(lease).toEqual({ id: grant.leaseId, client: { stateDir: '/state/run-1', ...scope } });
  expect(sdk.release).not.toHaveBeenCalled();
  await cloud.release(lease, releaseContext);
  expect(sdk.release).toHaveBeenCalledExactlyOnceWith(scope);
});

it('releases a declined retention grant before rejecting acquisition, without keeping it for release', async () => {
  sdk.allocate.mockResolvedValue({ ...grant, retainOnClose: false });
  let finishRelease!: () => void;
  sdk.release.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRelease = resolve; }));
  const cloud = cloudDevices({ provider: 'cloud', stateDir: '/state' });
  const settled = vi.fn();
  const acquiring = cloud.acquire(request);
  void acquiring.then(settled, settled);

  await vi.waitFor(() => expect(sdk.release).toHaveBeenCalledExactlyOnceWith(scope));
  expect(settled).not.toHaveBeenCalled();
  finishRelease();
  await expect(acquiring).rejects.toThrow(/retainOnClose/);
  await cloud.release({ id: grant.leaseId }, releaseContext);
  expect(sdk.release).toHaveBeenCalledExactlyOnceWith(scope);
});
