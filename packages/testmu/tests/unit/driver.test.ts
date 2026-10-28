import { afterEach, expect, it, vi } from 'vitest';
import type { DriverRequest } from '../../src/driver.ts';

const mocks = vi.hoisted(() => ({ allocate: vi.fn(), create: vi.fn() }));
vi.mock('agent-device', () => ({ createAgentDeviceClient: (config: unknown) => { mocks.create(config); return { leases: { allocate: mocks.allocate } }; } }));
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

async function answer(request: DriverRequest): Promise<unknown> {
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

const allocate = { tenant: 'testmu', runId: 'run', leaseProvider: 'testmu', retainOnClose: true };

it('allocates from the daemon in its state directory and reports the grant', async () => {
  mocks.allocate.mockResolvedValue({ leaseId: 'lease', tenantId: 'testmu', runId: 'run', backend: 'ios-instance', retainOnClose: true });
  await expect(answer({ stateDir: '/daemon', allocate })).resolves.toEqual({ grant: { leaseId: 'lease', tenantId: 'testmu', runId: 'run', retainOnClose: true } });
  expect(mocks.create).toHaveBeenCalledWith({ stateDir: '/daemon' });
  expect(mocks.allocate).toHaveBeenCalledWith(allocate);
});

it('reports a daemon that did not keep the lease', async () => {
  mocks.allocate.mockResolvedValueOnce({ leaseId: 'lease', tenantId: 'testmu', runId: 'run', backend: 'ios-instance' });
  await expect(answer({ stateDir: '/daemon', allocate })).resolves.toMatchObject({ grant: { retainOnClose: false } });
});

it('reports an allocation error', async () => {
  mocks.allocate.mockRejectedValueOnce(new Error('No device named Pixel 99'));
  await expect(answer({ stateDir: '/daemon', allocate })).resolves.toEqual({ error: 'No device named Pixel 99' });
});
