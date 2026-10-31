/**
 * `agentDeviceLeases()` against a stubbed daemon driver: the lease it
 * allocates and hands the worker, the environment and home each daemon gets,
 * and the release on every exit path. `lease-daemon.test.ts` covers the stop
 * report against the installed agent-device.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceReleaseContext, DeviceRequest } from '../../src/index.ts';
import { agentDeviceLeases, type AgentDeviceLeaseRequest } from '../../src/lease/index.ts';
import type { DriverRequest } from '../../src/lease/driver.ts';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async (_stateDir: string, _env: NodeJS.ProcessEnv, _leaseId: string | undefined, _label: string, _signal: AbortSignal) => {}),
  heartbeat: vi.fn(),
  stopHeartbeat: vi.fn(async () => {}),
  rm: vi.fn(),
}));
vi.mock('../../src/lease/daemon.ts', async (original) => ({ ...(await original<typeof import('../../src/lease/daemon.ts')>()), startDriver: mocks.start, stopDriver: mocks.stop }));
vi.mock('../../src/lease/heartbeat.ts', () => ({ LEASE_TTL_MS: 60_000, startHeartbeat: mocks.heartbeat }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  mocks.rm.mockImplementation(fs.rm);
  return { ...fs, rm: mocks.rm };
});

const env = { PATH: '/bin' };
const allocation: AgentDeviceLeaseRequest = {
  env: { CLOUD_USERNAME: 'ada', CLOUD_ACCESS_KEY: 'cloud-key' },
  selectors: { device: 'Google Pixel 9', providerOsVersion: '16.0', providerApp: 'cloud://APP0' },
  summary: 'Google Pixel 9, android 16.0',
};

beforeEach(() => {
  vi.clearAllMocks();
  let leases = 0;
  mocks.start.mockImplementation(async ({ allocate }: DriverRequest) => ({ leaseId: `lease-${++leases}`, tenantId: allocate.tenant, runId: allocate.runId, retainOnClose: true }));
  mocks.stop.mockImplementation(async () => {});
  mocks.heartbeat.mockResolvedValue(mocks.stopHeartbeat);
});

afterEach(() => {
  for (const [call] of mocks.start.mock.calls) rmSync(join((call as DriverRequest).stateDir, '..'), { recursive: true, force: true });
});

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    platform: 'android',
    runId: 'run-1',
    targetName: 'android',
    slot: 0,
    slots: 2,
    agentDeviceVersion: '0.21.35',
    projectRoot: '/project',
    env,
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

const context: DeviceReleaseContext = { runId: 'run-1', targetName: 'android', env, signal: new AbortController().signal, log: () => undefined };

const driver = (call = 0) => mocks.start.mock.calls[call]![0] as DriverRequest;
const driverEnv = (call = 0) => mocks.start.mock.calls[call]![1] as NodeJS.ProcessEnv;
const leases = () => agentDeviceLeases({ provider: 'cloud', label: 'Cloud' });

describe('agentDeviceLeases()', () => {
  it('allocates a retained lease from its own daemon, with the selectors and the platform backend', async () => {
    const lease = await leases().acquire(request(), allocation);
    expect(driver().allocate).toEqual({
      tenant: 'cloud',
      runId: 'run-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'cloud',
      platform: 'android',
      target: 'mobile',
      device: 'Google Pixel 9',
      providerOsVersion: '16.0',
      providerApp: 'cloud://APP0',
      ttlMs: 60_000,
      retainOnClose: true,
    });
    expect(mocks.start).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'Cloud');
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(true);
    await leases().acquire(request({ platform: 'ios' }), allocation);
    expect(driver(1).allocate).toMatchObject({ leaseBackend: 'ios-instance', platform: 'ios' });
    expect(lease.id).toBe('lease-1');
  });

  it('hands the worker the lease scope and the selectors as JSON client configuration, without credentials', async () => {
    const req = request();
    const lease = await leases().acquire(req, allocation);
    expect(lease).toEqual({
      id: 'lease-1',
      client: {
        stateDir: driver().stateDir,
        tenant: 'cloud',
        runId: 'run-1',
        leaseId: 'lease-1',
        leaseBackend: 'android-instance',
        leaseProvider: 'cloud',
        platform: 'android',
        target: 'mobile',
        device: 'Google Pixel 9',
        providerOsVersion: '16.0',
        providerApp: 'cloud://APP0',
      },
    });
    const json = JSON.stringify(lease);
    expect(JSON.parse(json)).toEqual(lease);
    expect(json).not.toContain('cloud-key');
    expect(mocks.heartbeat).toHaveBeenCalledWith(driver().stateDir, { tenant: 'cloud', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'cloud' }, req.log);
  });

  it('logs the granted lease with its summary', async () => {
    const lines: string[] = [];
    await leases().acquire(request({ log: (line) => lines.push(line) }), allocation);
    expect(lines).toEqual(['lease lease-1: Google Pixel 9, android 16.0']);
  });

  it('releases a granted lease when the run\'s log throws, instead of losing it', async () => {
    await expect(leases().acquire(request({ log: () => { throw new Error('log closed'); } }), allocation)).rejects.toThrow('log closed');
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), 'lease-1', 'Cloud', expect.any(AbortSignal));
    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("gives each lease's daemon its own state, agent-device home, and the service's env, and never mutates process.env", async () => {
    const before = { ...process.env };
    const provider = leases();
    const runEnv = { ...env, CLOUD_USERNAME: 'run-user', AGENT_DEVICE_STATE_DIR: '/foreign', AGENT_DEVICE_HOME: '/foreign-home', AGENT_DEVICE_DAEMON_POLICY: '/policy.json' };
    await Promise.all([provider.acquire(request({ env: runEnv }), allocation), provider.acquire(request({ slot: 1, env: runEnv }), allocation)]);
    expect(driver(0).stateDir).not.toBe(driver(1).stateDir);
    expect(driverEnv(0).AGENT_DEVICE_HOME).not.toBe(driverEnv(1).AGENT_DEVICE_HOME);
    expect(driverEnv(0)).toMatchObject({ CLOUD_USERNAME: 'ada', CLOUD_ACCESS_KEY: 'cloud-key', PATH: '/bin', AGENT_DEVICE_DAEMON_POLICY: '/policy.json' });
    expect(driverEnv(0).AGENT_DEVICE_STATE_DIR).toBeUndefined();
    expect(driverEnv(0).AGENT_DEVICE_HOME).toBe(join(driver(0).stateDir, '..', 'home'));
    expect(process.env).toEqual(before);
  });

  it("drops agent-device daemon settings from the service's env too, so it can't pick another daemon or home", async () => {
    await leases().acquire(request(), { ...allocation, env: { ...allocation.env, AGENT_DEVICE_HOME: '/foreign-home', AGENT_DEVICE_DAEMON_BASE_URL: 'http://foreign' } });
    expect(driverEnv().AGENT_DEVICE_HOME).toBe(join(driver().stateDir, '..', 'home'));
    expect(driverEnv().AGENT_DEVICE_DAEMON_BASE_URL).toBeUndefined();
    expect(driverEnv()).toMatchObject({ CLOUD_USERNAME: 'ada' });
  });

  it("prepares the daemon's home before it starts", async () => {
    const prepareHome = vi.fn(async (home: string) => {
      await writeFile(join(home, '..', 'prepared'), home);
    });
    await leases().acquire(request(), { ...allocation, prepareHome });
    expect(prepareHome).toHaveBeenCalledWith(driverEnv().AGENT_DEVICE_HOME);
    expect(readFileSync(join(driver().stateDir, '..', 'prepared'), 'utf8')).toBe(driverEnv().AGENT_DEVICE_HOME);
    expect(prepareHome.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]!);
  });

  it('allocates nothing once the run is interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(leases().acquire(request({ signal: controller.signal }), allocation)).rejects.toThrow();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('stops the daemon of a lease granted after an interrupt instead of handing it over', async () => {
    const controller = new AbortController();
    mocks.start.mockImplementationOnce(async () => {
      controller.abort();
      return { leaseId: 'lease-1', tenantId: 'cloud', runId: 'run-1', retainOnClose: true };
    });
    await expect(leases().acquire(request({ signal: controller.signal }), allocation)).rejects.toThrow('cancelled');
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), 'lease-1', 'Cloud', expect.any(AbortSignal));
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
  });

  it('stops the daemon when agent-device does not acknowledge retainOnClose', async () => {
    mocks.start.mockResolvedValueOnce({ leaseId: 'lease-1', tenantId: 'cloud', runId: 'run-1', retainOnClose: false });
    await expect(leases().acquire(request(), allocation)).rejects.toThrow('agent-device did not acknowledge retainOnClose. Closing the engine session could end the Cloud lease before run-end release');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the daemon after a failed allocation or home setup, and reports a failed cleanup with the cause', async () => {
    mocks.start.mockRejectedValueOnce(new Error('no capacity'));
    await expect(leases().acquire(request(), allocation)).rejects.toThrow('no capacity');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    // Nothing was granted, so a stop that finds no daemon has nothing to confirm.
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), undefined, 'Cloud', expect.any(AbortSignal));
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    mocks.start.mockRejectedValueOnce(new Error('no capacity'));
    mocks.stop.mockRejectedValueOnce(new Error('daemon did not stop'));
    await expect(leases().acquire(request(), allocation)).rejects.toThrow('Cloud lease failed: no capacity; cleanup also failed: daemon did not stop');
    await expect(leases().acquire(request(), { ...allocation, prepareHome: async () => { throw new Error('plugin missing'); } })).rejects.toThrow('plugin missing');
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.stop).toHaveBeenCalledTimes(3);
  });

  it('stops the heartbeat and the daemon and removes its directory once, however often it is asked', async () => {
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    await Promise.all([provider.release(lease, context), provider.release(lease, context)]);
    await provider.release(lease, context);
    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), 'lease-1', 'Cloud', context.signal);
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
  });

  it('tries a release again after one failed', async () => {
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    mocks.stop.mockRejectedValueOnce(new Error('daemon busy'));
    await expect(provider.release(lease, context)).rejects.toThrow('daemon busy');
    await provider.release(lease, context);
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it('keeps failing to release a lease whose session end is unknown once its daemon is gone', async () => {
    const { assertSessionsEnded } = await vi.importActual<typeof import('../../src/lease/daemon.ts')>('../../src/lease/daemon.ts');
    const stopReport = (data: unknown) => JSON.stringify({ success: true, data });
    const forced = stopReport({ stopped: true, mode: 'forced', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: [] });
    const notRunning = stopReport({ stopped: false, mode: 'not-running', providerReleases: { status: 'completed', released: [], pending: [] }, warnings: [] });
    mocks.stop.mockImplementation(async (_stateDir, _env, leaseId, label) => assertSessionsEnded(mocks.stop.mock.calls.length === 1 ? forced : notRunning, leaseId, label));
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    const dir = driver().stateDir.replace(/state$/, '');
    await expect(provider.release(lease, context)).rejects.toThrow('agent-device could not confirm its Cloud sessions ended');
    // The forced stop killed the daemon, so every later stop finds none: the release never resolves without evidence.
    await expect(provider.release(lease, context)).rejects.toThrow('agent-device found no daemon running for lease lease-1, so nothing confirms its Cloud session ended');
    await expect(provider.release(lease, context)).rejects.toThrow('agent-device found no daemon running for lease lease-1');
    expect(mocks.stop).toHaveBeenCalledTimes(3);
    expect(existsSync(dir)).toBe(true);
  });

  it('cleans up without stopping again when the stop confirmed the session ended but the cleanup failed', async () => {
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    mocks.rm.mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'));
    await expect(provider.release(lease, context)).rejects.toThrow('EBUSY');
    await provider.release(lease, context);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(2);
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
  });

  it('ignores a lease it does not hold', async () => {
    await leases().release({ id: 'other', client: { stateDir: '/tmp/x' } }, context);
    expect(mocks.stop).not.toHaveBeenCalled();
  });
});
