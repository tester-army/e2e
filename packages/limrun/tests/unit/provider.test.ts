import { beforeEach, expect, it, vi } from 'vitest';
import { limrun } from '../../src/provider.ts';
import type { DeviceRequest } from '@e2e-dev/mobile';

const mocks = vi.hoisted(() => {
  const endpoints = () => ({ create: vi.fn(), get: vi.fn(), delete: vi.fn<(id: string, options: { signal: AbortSignal }) => Promise<void>>(async () => {}) });
  return {
    heartbeat: vi.fn(), stopHeartbeat: vi.fn(async () => {}), ios: endpoints(), android: endpoints(), options: vi.fn(), start: vi.fn(), stop: vi.fn(async () => {}), version: vi.fn(), androidTools: vi.fn(async () => {}),
    NotFoundError: class NotFoundError extends Error {},
  };
});
vi.mock('@limrun/api', () => ({ default: class {
  static NotFoundError = mocks.NotFoundError;
  iosInstances = mocks.ios;
  androidInstances = mocks.android;
  constructor(options: unknown) { mocks.options(options); }
} }));
vi.mock('../../src/heartbeat.ts', () => ({ startHeartbeat: mocks.heartbeat }));
vi.mock('../../src/daemon.ts', () => ({ assertAndroidTools: mocks.androidTools, assertDriverVersion: mocks.version, startDriver: mocks.start, stopDriver: mocks.stop }));

const instance = (id = 'ios-test') => ({ metadata: { id }, status: { state: 'ready', apiUrl: 'https://device.example', token: 'instance-secret', adbWebSocketUrl: 'wss://adb.example' } });
const request = (overrides: Partial<DeviceRequest> = {}): DeviceRequest => ({
  platform: 'ios', runId: 'run-a', targetName: 'ios', slot: 0, slots: 1, agentDeviceVersion: '0.21.22',
  projectRoot: '/project', env: { LIMRUN_API_KEY: 'run-key', PATH: '/bin' }, signal: new AbortController().signal, log: vi.fn(), ...overrides,
});
const cleanup = (env = request().env) => ({ runId: 'run-a', targetName: 'ios', env, signal: new AbortController().signal, log: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.heartbeat.mockResolvedValue(mocks.stopHeartbeat);
  mocks.ios.create.mockResolvedValue(instance());
  mocks.ios.get.mockResolvedValue(instance());
  mocks.android.create.mockResolvedValue(instance('android-test'));
  mocks.android.get.mockResolvedValue(instance('android-test'));
  mocks.start.mockResolvedValue({ client: { stateDir: '/state', leaseId: 'driver-lease' }, deviceId: 'limrun:ios:driver-lease' });

});

it('requires the run key and matching driver before creating a device', async () => {
  await expect(limrun().acquire(request({ env: {} }))).rejects.toThrow(/LIMRUN_API_KEY/);
  expect(mocks.ios.create).not.toHaveBeenCalled();
  expect(mocks.version).toHaveBeenCalledWith('0.21.22');
});

it.each([undefined, 'https://run.example'])('selects the API endpoint from the run environment: %s', async (baseURL) => {
  const provider = limrun();
  const lease = await provider.acquire(request({ env: { LIMRUN_API_KEY: 'run-key', LIMRUN_BASE_URL: baseURL } }));
  expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({
    apiKey: 'run-key', baseURL: baseURL ?? 'https://api.limrun.com',
  }));
  await provider.release(lease, cleanup());
});

it('isolates concurrent slots and targets, uses run credentials, and never mutates process.env', async () => {
  const before = { ...process.env };
  const provider = limrun({ region: 'eu', hardTimeout: '30m', ios: { model: 'ipad' }, android: { osVersion: '16' } });
  const env = { LIMRUN_API_KEY: 'run-key', LIM_IOS_INSTANCE_URL: 'foreign', LIM_IOS_INSTANCE_TOKEN: 'foreign-token', AGENT_DEVICE_STATE_DIR: 'foreign-dir', AGENT_DEVICE_DAEMON_POLICY: '/policy.json' };
  const [ios, android] = await Promise.all([provider.acquire(request({ env })), provider.acquire(request({ platform: 'android', targetName: 'android', slot: 1, env }))]);
  try {
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'run-key', maxRetries: 0 }));
    expect(mocks.ios.create).toHaveBeenCalledWith(expect.objectContaining({ spec: { region: 'eu', hardTimeout: '30m', model: 'ipad' } }));
    expect(mocks.android.create).toHaveBeenCalledWith(expect.objectContaining({ spec: { region: 'eu', hardTimeout: '30m', clues: [{ kind: 'OSVersion', osVersion: '16' }] } }));
    const calls = mocks.start.mock.calls.toSorted((a,b) => b[0].platform.localeCompare(a[0].platform));
    expect(calls[0]![0].stateDir).not.toBe(calls[1]![0].stateDir);
    expect(calls[0]![1]).toMatchObject({ LIMRUN_API_KEY: 'run-key', LIM_IOS_INSTANCE_URL: 'https://device.example', LIM_IOS_INSTANCE_TOKEN: 'instance-secret' });
    expect(calls[1]![1].LIM_IOS_INSTANCE_URL).toBeUndefined();
    expect(calls[0]![1].AGENT_DEVICE_STATE_DIR).toBeUndefined();
    expect(calls[0]![1].AGENT_DEVICE_DAEMON_POLICY).toBe('/policy.json');
    expect(process.env).toEqual(before);
  } finally {
    await provider.release(ios, cleanup());
    await provider.release(android, cleanup());
  }
  expect(mocks.ios.delete).toHaveBeenCalledWith('ios-test', expect.anything());
  expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(2);
  expect(mocks.android.delete).toHaveBeenCalledWith('android-test', expect.anything());
});

it('hands installation to the driver and reports only the installed identity', async () => {
  mocks.start.mockResolvedValueOnce({ client: { stateDir: '/state' }, deviceId: 'device', installedApp: 'dev.example' });
  const provider = limrun();
  const lease = await provider.acquire(request({ appPath: '/project/build/App.app', app: 'dev.example' }));
  expect(lease.installedApp).toBe('dev.example');
  expect(mocks.start.mock.calls[0]![0]).toMatchObject({ appPath: '/project/build/App.app', app: 'dev.example' });
  await provider.release(lease, cleanup());
});

it('cleans a device when driver setup or install fails, using a fresh cleanup signal', async () => {
  const controller = new AbortController();
  mocks.start.mockImplementationOnce(async () => { controller.abort(); throw new Error('install failed'); });
  await expect(limrun().acquire(request({ signal: controller.signal }))).rejects.toThrow(/install failed/);
  expect(mocks.stop).toHaveBeenCalled();
  expect(mocks.ios.delete).toHaveBeenCalledWith('ios-test', { signal: expect.any(AbortSignal) });
  expect(mocks.ios.delete.mock.calls[0]![1].signal.aborted).toBe(false);
});

it('tolerates a read-model 404 while waiting for readiness', async () => {
  mocks.ios.create.mockResolvedValueOnce({ ...instance(), status: { state: 'creating' } });
  mocks.ios.get.mockRejectedValueOnce(new mocks.NotFoundError('not visible yet'));
  const provider = limrun();
  const lease = await provider.acquire(request());
  expect(mocks.ios.get).toHaveBeenCalledTimes(2);
  await provider.release(lease, cleanup());
});

it('still deletes the device if stopping the daemon fails, and reports the cleanup failure', async () => {
  const provider = limrun();
  const lease = await provider.acquire(request());
  mocks.stop.mockRejectedValueOnce(new Error('daemon did not stop'));
  await expect(provider.release(lease, cleanup())).rejects.toThrow(/Could not fully release/);
  expect(mocks.ios.delete).toHaveBeenCalled();
  await provider.release(lease, cleanup());
});

it('treats a device that expired before release as already cleaned up', async () => {
  const provider = limrun();
  const lease = await provider.acquire(request());
  mocks.ios.delete.mockRejectedValueOnce(new mocks.NotFoundError('already gone'));
  await provider.release(lease, cleanup());
  await provider.release(lease, cleanup());
  expect(mocks.ios.delete).toHaveBeenCalledTimes(1);
});

it('refuses missing Android tools before allocating anything', async () => {
  mocks.androidTools.mockRejectedValueOnce(new Error('adb missing'));
  await expect(limrun().acquire(request({ platform: 'android' }))).rejects.toThrow(/adb missing/);
  expect(mocks.android.create).not.toHaveBeenCalled();
});
