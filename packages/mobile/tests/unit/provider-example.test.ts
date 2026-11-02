import { beforeEach, expect, it, vi } from 'vitest';
import type { DeviceProvider, DeviceRequest } from '../../src/provider.ts';

const leases = { acquire: vi.fn(), release: vi.fn() };
const agentDeviceLeases = vi.fn(() => leases);
// Docs and mobile resolve the same built @e2e-dev/mobile through the workspace link.
vi.doMock('../../../../docs/node_modules/@e2e-dev/mobile/dist/lease/index.js', () => ({ agentDeviceLeases }));
// Load the executable docs without including them in the mobile package's rootDir.
const exampleModule = new URL('../../../../docs/examples/mobile/device-cloud-provider.ts', import.meta.url).href;
const { cloudDevices } = (await import(exampleModule)) as {
  cloudDevices: (options: { provider: string; device: string; osVersion: string; app: string }) => DeviceProvider;
};

const request: DeviceRequest = {
  platform: 'ios',
  runId: 'run-1',
  targetName: 'ios',
  slot: 0,
  slots: 1,
  agentDeviceVersion: '0.21.35',
  projectRoot: '/project',
  env: { CLOUD_TOKEN: 'token' },
  signal: new AbortController().signal,
  log: () => undefined,
};
const options = { provider: 'cloud', device: 'iPhone 16', osVersion: '18', app: 'cloud://APP' };

beforeEach(() => {
  vi.clearAllMocks();
  leases.acquire.mockResolvedValue({ id: 'lease-1', client: { leaseId: 'lease-1' } });
});

it('leases with the token, the selectors, and a summary, and releases through the same leases', async () => {
  const cloud = cloudDevices(options);
  expect(agentDeviceLeases).toHaveBeenCalledWith({ provider: 'cloud', label: 'cloud' });
  const lease = await cloud.acquire(request);
  expect(leases.acquire).toHaveBeenCalledWith(request, {
    env: { CLOUD_TOKEN: 'token' },
    selectors: { device: 'iPhone 16', providerOsVersion: '18', providerApp: 'cloud://APP' },
    summary: 'iPhone 16, ios 18',
  });
  const context = { runId: 'run-1', targetName: 'ios', env: request.env, signal: request.signal, log: request.log };
  await cloud.release(lease, context);
  expect(leases.release).toHaveBeenCalledWith(lease, context);
});

it('leases nothing without a token', async () => {
  await expect(cloudDevices(options).acquire({ ...request, env: {} })).rejects.toThrow('CLOUD_TOKEN is not set');
  expect(leases.acquire).not.toHaveBeenCalled();
});
