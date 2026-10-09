import { afterEach, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../../src/heartbeat.ts';

const mocks = vi.hoisted(() => ({ heartbeat: vi.fn(), create: vi.fn() }));
vi.mock('agent-device', () => ({ createAgentDeviceClient: (config: unknown) => { mocks.create(config); return { leases: { heartbeat: mocks.heartbeat } }; } }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

it('renews an idle scoped lease beyond its expiry window and stops before daemon cleanup', async () => {
  vi.useFakeTimers();
  vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'unrelated-token');
  vi.stubEnv('AGENT_DEVICE_DAEMON_TRANSPORT', 'http');
  mocks.heartbeat.mockResolvedValue({});
  const binding = { client: { stateDir: '/worker-2', tenant: 'e2e', runId: 'run', leaseId: 'lease-2' }, deviceId: 'device-2' };
  const stop = await startHeartbeat(binding, vi.fn());
  expect(mocks.create).toHaveBeenCalledWith({ ...binding.client, daemonBaseUrl: '', daemonAuthToken: '', daemonTransport: 'auto' });
  await vi.advanceTimersByTimeAsync(140_000);
  expect(mocks.heartbeat).toHaveBeenCalledTimes(8);
  expect(mocks.heartbeat).toHaveBeenLastCalledWith({ leaseId: 'lease-2', ttlMs: 60_000, signal: expect.any(AbortSignal) });
  await stop();
  await vi.advanceTimersByTimeAsync(140_000);
  expect(mocks.heartbeat).toHaveBeenCalledTimes(8);
});

it('reports transient renewal failures, retries, and cancels an in-flight beat on release', async () => {
  vi.useFakeTimers();
  const log = vi.fn();
  mocks.heartbeat.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('transport unavailable'));
  const stop = await startHeartbeat({ client: { leaseId: 'lease' }, deviceId: 'device' }, log);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(log).toHaveBeenCalledWith('driver lease renewal failed: transport unavailable');
  let signal: AbortSignal | undefined;
  mocks.heartbeat.mockImplementationOnce((options: { signal: AbortSignal }) => new Promise((_, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  await vi.advanceTimersByTimeAsync(20_000);
  await stop();
  expect(signal?.aborted).toBe(true);
  expect(log).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.heartbeat).toHaveBeenCalledTimes(3);
});
