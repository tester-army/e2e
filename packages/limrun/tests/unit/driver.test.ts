import { afterEach, expect, it, vi } from 'vitest';
import type { DriverRequest } from '../../src/driver.ts';

const mocks = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock('agent-device', () => ({ createAgentDeviceClient: () => ({
  leases: { allocate: async () => ({ retainOnClose: true, tenantId: 'e2e', runId: 'run', leaseId: 'lease', backend: 'ios-instance' }) },
  apps: { install: mocks.install },
}) }));
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

it.each(['ios', 'android'] as const)('uses the requested %s app when installation returns no identifier', async (platform) => {
  mocks.install.mockResolvedValue({});
  const once = vi.spyOn(process, 'once');
  await import('../../src/driver.ts');
  const listener = once.mock.calls.find(([event]) => event === 'message')![1] as (request: DriverRequest) => void;
  process.removeListener('message', listener);
  let complete!: (message: unknown) => void;
  const sent = new Promise<unknown>((resolve) => { complete = resolve; });
  vi.spyOn(process, 'send').mockImplementation((message) => { complete(message); return true; });
  listener({ stateDir: '/daemon', runId: 'run', slot: 0, platform, app: 'com.example.app', appPath: '/build' });
  await expect(sent).resolves.toMatchObject({ binding: { installedApp: 'com.example.app' } });
});
