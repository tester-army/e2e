import { afterEach, expect, it, vi } from 'vitest';
import type { DriverRequest } from '../../src/driver.ts';

const mocks = vi.hoisted(() => ({ install: vi.fn(), create: vi.fn() }));
vi.mock('agent-device', () => ({ createAgentDeviceClient: (config: unknown) => {
  mocks.create(config);
  return {
    leases: { allocate: async () => ({ retainOnClose: true, tenantId: 'e2e', runId: 'run', leaseId: 'lease', backend: 'ios-instance' }) },
    apps: { install: mocks.install },
  };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.resetModules(); });

/** Runs the driver process's `attach` on `request` and returns the message it sends back. */
async function attach(request: DriverRequest): Promise<unknown> {
  const once = vi.spyOn(process, 'once');
  await import('../../src/driver.ts');
  const listener = once.mock.calls.find(([event]) => event === 'message')![1] as (request: DriverRequest) => void;
  process.removeListener('message', listener);
  let complete!: (message: unknown) => void;
  const sent = new Promise<unknown>((resolve) => { complete = resolve; });
  vi.spyOn(process, 'send').mockImplementation((message) => { complete(message); return true; });
  listener(request);
  return sent;
}

it.each(['ios', 'android'] as const)('uses the requested %s app when installation returns no identifier', async (platform) => {
  mocks.install.mockResolvedValue({});
  await expect(attach({ stateDir: '/daemon', runId: 'run', slot: 0, platform, app: 'com.example.app', appPath: '/build' })).resolves.toMatchObject({ binding: { installedApp: 'com.example.app' } });
});

it('names a session for its own clients and keeps it out of the client configuration the engine receives', async () => {
  mocks.install.mockResolvedValue({ appId: 'com.example.app' });
  const session = expect.stringMatching(/^e2e-lease-[0-9a-f]{8}$/);
  const scope = { stateDir: '/daemon', tenant: 'e2e', runId: 'run', leaseId: 'lease', leaseBackend: 'ios-instance', leaseProvider: 'limrun' };
  // Exact: `@e2e-dev/mobile` rejects a lease whose client names `session` or the daemon connection.
  await expect(attach({ stateDir: '/daemon', runId: 'run', slot: 0, platform: 'ios', appPath: '/build' })).resolves.toEqual({
    binding: { client: scope, deviceId: 'limrun:ios:lease', installedApp: 'com.example.app' },
  });
  expect(mocks.create.mock.calls).toEqual([[{ stateDir: '/daemon', session }], [{ ...scope, session }]]);
});
