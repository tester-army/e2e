import { afterEach, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../../src/lease/heartbeat.ts';

const mocks = vi.hoisted(() => ({ heartbeat: vi.fn(), create: vi.fn() }));
vi.mock('agent-device', () => ({ createAgentDeviceClient: (config: unknown) => { mocks.create(config); return { leases: { heartbeat: mocks.heartbeat } }; } }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

const scope = { tenant: 'browserstack', runId: 'run', leaseId: 'lease-2', leaseBackend: 'android-instance' as const, leaseProvider: 'browserstack' };

it("renews the lease on the lease's own daemon until stopped", async () => {
  vi.useFakeTimers();
  mocks.heartbeat.mockResolvedValue({});
  const stop = await startHeartbeat('/state', scope, vi.fn());
  expect(mocks.create).toHaveBeenCalledWith({ stateDir: '/state', daemonBaseUrl: '', daemonAuthToken: '', daemonTransport: 'auto' });
  await vi.advanceTimersByTimeAsync(140_000);
  expect(mocks.heartbeat).toHaveBeenCalledTimes(8);
  expect(mocks.heartbeat).toHaveBeenLastCalledWith({ ...scope, ttlMs: 60_000, signal: expect.any(AbortSignal) });
  await stop();
  await vi.advanceTimersByTimeAsync(140_000);
  expect(mocks.heartbeat).toHaveBeenCalledTimes(8);
});

it('logs a failed renewal and retries, surviving a closed log, and cancels an in-flight beat on stop', async () => {
  vi.useFakeTimers();
  const log = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('reporter closed'); });
  mocks.heartbeat.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('transport unavailable')).mockRejectedValueOnce(new Error('daemon gone'));
  const stop = await startHeartbeat('/state', scope, log);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(log).toHaveBeenCalledWith('lease lease-2: renewal failed: transport unavailable');
  expect(log).toHaveBeenCalledTimes(2);
  let signal: AbortSignal | undefined;
  mocks.heartbeat.mockImplementationOnce((options: { signal: AbortSignal }) => new Promise((_, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  await vi.advanceTimersByTimeAsync(20_000);
  await stop();
  expect(signal?.aborted).toBe(true);
  expect(log).toHaveBeenCalledTimes(2);
});
