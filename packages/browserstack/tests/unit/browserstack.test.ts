/**
 * `browserstack()` against a stubbed daemon driver: the options it refuses, the
 * lease it allocates and hands the worker, the environment the daemon gets,
 * and the release on every exit path. `recording.test.ts` covers `record`.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserstack, type BrowserStackOptions } from '../../src/index.ts';
import type { DriverRequest } from '../../src/driver.ts';

const mocks = vi.hoisted(() => ({
  version: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(async (_stateDir: string, _env: NodeJS.ProcessEnv, _signal: AbortSignal) => {}),
  heartbeat: vi.fn(),
  upload: vi.fn(async (_endpoint: string, _credentials: unknown, _url: string, _signal: AbortSignal) => 'bs://UPLOADED'),
  stopHeartbeat: vi.fn(async () => {}),
}));
vi.mock('../../src/daemon.ts', () => ({ assertDriverVersion: mocks.version, startDriver: mocks.start, stopDriver: mocks.stop }));
vi.mock('../../src/sessions.ts', async (original) => ({ ...(await original<typeof import('../../src/sessions.ts')>()), uploadAppFromUrl: mocks.upload }));
vi.mock('../../src/heartbeat.ts', () => ({ LEASE_TTL_MS: 60_000, startHeartbeat: mocks.heartbeat }));

const ROOT = '/project';
const env = { BROWSERSTACK_USERNAME: 'ada', BROWSERSTACK_ACCESS_KEY: 'bs-key', PATH: '/bin' };
const options: BrowserStackOptions = { device: 'Google Pixel 9', osVersion: '16.0', app: 'bs://APP0' };

beforeEach(() => {
  vi.clearAllMocks();
  let leases = 0;
  mocks.start.mockImplementation(async ({ allocate }: DriverRequest) => ({ leaseId: `lease-${++leases}`, tenantId: allocate.tenant, runId: allocate.runId, retainOnClose: true }));
  mocks.heartbeat.mockResolvedValue(mocks.stopHeartbeat);
});

afterEach(() => {
  for (const [call] of mocks.start.mock.calls) rmSync(join((call as DriverRequest).stateDir, '..'), { recursive: true, force: true });
});

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    platform: 'android',
    runId: 'run-1',
    targetName: 'android',
    slot: 0,
    slots: 2,
    app: 'com.example.app',
    agentDeviceVersion: '0.21.28',
    projectRoot: ROOT,
    env,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

const context: DeviceReleaseContext = { runId: 'run-1', targetName: 'android', env, signal: new AbortController().signal, log: () => undefined };

const driver = (call = 0) => mocks.start.mock.calls[call]![0] as DriverRequest;
const driverEnv = (call = 0) => mocks.start.mock.calls[call]![1] as NodeJS.ProcessEnv;

describe('browserstack()', () => {
  it("is a device provider named browserstack that records through BrowserStack's own session video", () => {
    const provider = browserstack(options);
    expect(provider.name).toBe('browserstack');
    expect(provider.record).toBeTypeOf('function');
  });

  it("checks agent-device against the engine's before anything starts", async () => {
    mocks.version.mockImplementationOnce(() => {
      throw new Error('@e2e-dev/browserstack uses agent-device 0.21.28, but @e2e-dev/mobile uses 0.21.30. Install matching versions.');
    });
    await expect(browserstack(options).acquire(request({ agentDeviceVersion: '0.21.30' }))).rejects.toThrow(/Install matching versions/);
    expect(mocks.version).toHaveBeenCalledWith('0.21.30');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('allocates an Android lease from its own daemon, with the device selectors and dashboard labels', async () => {
    const provider = browserstack(options);
    const lease = await provider.acquire(request({ slot: 1 }));
    const { stateDir, allocate } = driver();
    expect(allocate).toEqual({
      tenant: 'browserstack',
      runId: 'run-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'browserstack',
      platform: 'android',
      target: 'mobile',
      device: 'Google Pixel 9',
      providerOsVersion: '16.0',
      providerApp: 'bs://APP0',
      providerProject: 'e2e',
      providerBuild: 'run-1',
      providerSessionName: 'e2e-run-1-android-2',
      ttlMs: 60_000,
      retainOnClose: true,
    });
    expect(existsSync(stateDir.replace(/state$/, ''))).toBe(true);
    await provider.release(lease, context);
  });

  it('allocates an iOS lease with its own project, build, and session name', async () => {
    await browserstack({ device: 'iPhone 16', osVersion: '18', app: 'bs://APP123', project: 'shop', build: 'nightly', sessionName: 'checkout' }).acquire(request({ platform: 'ios' }));
    expect(driver().allocate).toMatchObject({
      leaseBackend: 'ios-instance',
      platform: 'ios',
      device: 'iPhone 16',
      providerOsVersion: '18',
      providerApp: 'bs://APP123',
      providerProject: 'shop',
      providerBuild: 'nightly',
      providerSessionName: 'checkout-1',
    });
  });

  it("names each slot's session after the run, the target, and the slot, and keeps a given name unique per slot", async () => {
    const provider = browserstack(options);
    await provider.acquire(request({ runId: 'run-7', targetName: 'pixel', slot: 0, slots: 3 }));
    await provider.acquire(request({ runId: 'run-7', targetName: 'pixel', slot: 2, slots: 3 }));
    await browserstack({ ...options, sessionName: 'checkout' }).acquire(request({ slot: 2, slots: 3 }));
    await browserstack({ ...options, sessionName: 'checkout' }).acquire(request({ slot: 0, slots: 1 }));
    expect(mocks.start.mock.calls.map(([call]) => (call as DriverRequest).allocate.providerSessionName)).toEqual(['e2e-run-7-pixel-1', 'e2e-run-7-pixel-3', 'checkout-3', 'checkout']);
  });

  it("passes the device features to the allocation and the worker under agent-device's keys", async () => {
    const lease = await browserstack({ ...options, orientation: 'landscape', geoLocation: 'US', timezone: 'New_York', language: 'fr', locale: 'fr_FR', appiumVersion: '2.16.2' }).acquire(request());
    const features = {
      providerDeviceOrientation: 'landscape',
      providerGeoLocation: 'US',
      providerTimezone: 'New_York',
      providerLanguage: 'fr',
      providerLocale: 'fr_FR',
      providerAppiumVersion: '2.16.2',
    };
    expect(driver().allocate).toMatchObject(features);
    expect(lease.client).toMatchObject(features);
  });

  it('resolves a local build against the project root, never the working directory', async () => {
    await browserstack({ ...options, app: 'build/app.apk' }).acquire(request());
    expect(driver(0).allocate.providerApp).toBe(join(ROOT, 'build', 'app.apk'));
    await browserstack({ ...options, app: join('/', 'builds', 'app.apk') }).acquire(request());
    expect(driver(1).allocate.providerApp).toBe(join('/', 'builds', 'app.apk'));
  });

  it('hands the worker the lease scope and the selectors as JSON client configuration, without credentials', async () => {
    const req = request();
    const lease = await browserstack(options).acquire(req);
    expect(lease).toEqual({
      id: 'lease-1',
      client: {
        stateDir: driver().stateDir,
        tenant: 'browserstack',
        runId: 'run-1',
        leaseId: 'lease-1',
        leaseBackend: 'android-instance',
        leaseProvider: 'browserstack',
        platform: 'android',
        target: 'mobile',
        device: 'Google Pixel 9',
        providerOsVersion: '16.0',
        providerApp: 'bs://APP0',
          providerProject: 'e2e',
        providerBuild: 'run-1',
        providerSessionName: 'e2e-run-1-android-1',
      },
    });
    const json = JSON.stringify(lease);
    expect(JSON.parse(json)).toEqual(lease);
    expect(json).not.toContain('bs-key');
    expect(mocks.heartbeat).toHaveBeenCalledWith(driver().stateDir, { tenant: 'browserstack', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'browserstack' }, req.log);
    expect(req.lines).toEqual(['lease lease-1: Google Pixel 9, android 16.0; session e2e-run-1-android-1 reserved']);
  });

  it("gives each lease's daemon its own state, agent-device home, and the run's credentials, and never mutates process.env", async () => {
    const before = { ...process.env };
    const provider = browserstack(options);
    const runEnv = { ...env, BROWSERSTACK_USERNAME: ' ada ', AGENT_DEVICE_STATE_DIR: '/foreign', AGENT_DEVICE_HOME: '/foreign-home', AGENT_DEVICE_DAEMON_POLICY: '/policy.json' };
    await Promise.all([provider.acquire(request({ env: runEnv })), provider.acquire(request({ slot: 1, env: runEnv }))]);
    expect(driver(0).stateDir).not.toBe(driver(1).stateDir);
    expect(driverEnv(0).AGENT_DEVICE_HOME).not.toBe(driverEnv(1).AGENT_DEVICE_HOME);
    expect(driverEnv(0)).toMatchObject({ BROWSERSTACK_USERNAME: 'ada', BROWSERSTACK_ACCESS_KEY: 'bs-key', PATH: '/bin', AGENT_DEVICE_DAEMON_POLICY: '/policy.json' });
    expect(driverEnv(0).AGENT_DEVICE_STATE_DIR).toBeUndefined();
    expect(driverEnv(0).AGENT_DEVICE_HOME).toBe(join(driver(0).stateDir, '..', 'home'));
    expect(process.env).toEqual(before);
  });

  it.each([
    [{}, 'BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY are not set'],
    [{ BROWSERSTACK_USERNAME: 'ada' }, 'BROWSERSTACK_ACCESS_KEY is not set'],
    [{ BROWSERSTACK_USERNAME: '  ', BROWSERSTACK_ACCESS_KEY: 'bs-key' }, 'BROWSERSTACK_USERNAME is not set'],
  ])("fails before any daemon starts without credentials in the run's environment (%j)", async (runEnv, message) => {
    await expect(browserstack(options).acquire(request({ env: runEnv }))).rejects.toThrow(
      `${message}; set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY to your BrowserStack username and access key in the environment \`e2e run\` starts in`,
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("refuses the target's app.appPath, since BrowserStack installs `app`", async () => {
    await expect(browserstack(options).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }))).rejects.toThrow("BrowserStack installs the app from `app`; leave the target's `app.appPath` out");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('allocates nothing once the run is interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(browserstack(options).acquire(request({ signal: controller.signal }))).rejects.toThrow();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('stops the daemon of a lease granted after an interrupt instead of handing it over', async () => {
    const controller = new AbortController();
    mocks.start.mockImplementationOnce(async () => {
      controller.abort();
      return { leaseId: 'lease-1', tenantId: 'browserstack', runId: 'run-1', retainOnClose: true };
    });
    const req = request({ signal: controller.signal });
    await expect(browserstack(options).acquire(req)).rejects.toThrow('cancelled');
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), expect.any(AbortSignal));
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
    expect(req.lines).toEqual([]);
  });

  it('stops the daemon when agent-device does not acknowledge retainOnClose', async () => {
    mocks.start.mockResolvedValueOnce({ leaseId: 'lease-1', tenantId: 'browserstack', runId: 'run-1', retainOnClose: false });
    await expect(browserstack(options).acquire(request())).rejects.toThrow('agent-device did not acknowledge retainOnClose. Closing the engine session could end the BrowserStack lease before run-end release');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the daemon after a failed allocation, and reports a failed cleanup with the cause', async () => {
    mocks.start.mockRejectedValueOnce(new Error('no capacity'));
    await expect(browserstack(options).acquire(request())).rejects.toThrow('no capacity');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    mocks.start.mockRejectedValueOnce(new Error('no capacity'));
    mocks.stop.mockRejectedValueOnce(new Error('daemon did not stop'));
    await expect(browserstack(options).acquire(request())).rejects.toThrow('BrowserStack lease failed: no capacity; cleanup also failed: daemon did not stop');
  });

  it('stops the heartbeat and the daemon and removes its directory once, however often it is asked', async () => {
    const provider = browserstack(options);
    const lease = await provider.acquire(request());
    await Promise.all([provider.release(lease, context), provider.release(lease, context)]);
    await provider.release(lease, context);
    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), context.signal);
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
  });

  it('tries a release again after one failed', async () => {
    const provider = browserstack(options);
    const lease = await provider.acquire(request());
    mocks.stop.mockRejectedValueOnce(new Error('daemon busy'));
    await expect(provider.release(lease, context)).rejects.toThrow('daemon busy');
    await provider.release(lease, context);
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it('ignores a lease it does not hold', async () => {
    await browserstack(options).release({ id: 'other', client: { stateDir: '/tmp/x' } }, context);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it('rejects an option it does not take with INVALID_CONFIG, naming the nearest one', () => {
    expect(() => browserstack({ ...options, osVerison: '16.0' } as unknown as BrowserStackOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('osVersion') }));
    expect(() => browserstack({ ...options, stateDir: '.e2e' } as unknown as BrowserStackOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it.each(['device', 'osVersion', 'app'] as const)('requires `%s` with INVALID_CONFIG', (key) => {
    expect(() => browserstack({ ...options, [key]: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: `browserstack: \`${key}\` is required, as a non-empty string` }));
    const { [key]: _, ...rest } = options;
    expect(() => browserstack(rest as BrowserStackOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('refuses an orientation other than portrait or landscape', () => {
    expect(() => browserstack({ ...options, orientation: 'PORTRAIT' as 'portrait' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'browserstack: `orientation` must be \'portrait\' or \'landscape\', not "PORTRAIT"' }),
    );
  });

  it.each(['orientation', 'geoLocation', 'timezone', 'language', 'locale', 'appiumVersion', 'networkProfile', 'customNetwork'] as const)('refuses an empty or non-string `%s` with INVALID_CONFIG', (key) => {
    expect(() => browserstack({ ...options, [key]: ' ' } as unknown as BrowserStackOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: `browserstack: \`${key}\` must be a non-empty string` }));
    expect(() => browserstack({ ...options, [key]: 2 } as unknown as BrowserStackOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => browserstack({ ...options, [key]: null } as unknown as BrowserStackOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });


  it.each(['project', 'build', 'sessionName'] as const)('refuses an empty or non-string `%s` with INVALID_CONFIG', (key) => {
    for (const value of [' ', 1, null]) {
      expect(() => browserstack({ ...options, [key]: value } as unknown as BrowserStackOptions)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: `browserstack: \`${key}\` must be a non-empty string` }),
      );
    }
  });

  it('passes a network profile, a custom network, and noResignApp on iOS under agent-device\'s keys', async () => {
    await browserstack({ ...options, networkProfile: '4g-lte-advanced-good' }).acquire(request());
    expect(driver(0).allocate).toMatchObject({ providerNetworkProfile: '4g-lte-advanced-good' });
    await browserstack({ ...options, customNetwork: '1000' }).acquire(request());
    expect(driver(1).allocate).toMatchObject({ providerCustomNetwork: '1000' });
    await browserstack({ ...options, noResignApp: true }).acquire(request({ platform: 'ios' }));
    expect(driver(2).allocate).toMatchObject({ providerNoResignApp: true });
    await browserstack({ ...options, noResignApp: false }).acquire(request({ platform: 'ios' }));
    expect(driver(3).allocate).not.toHaveProperty('providerNoResignApp');
  });

  it('refuses noResignApp on Android before any daemon starts', async () => {
    await expect(browserstack({ ...options, noResignApp: true }).acquire(request())).rejects.toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'browserstack: `noResignApp` applies to iOS only' }));
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('refuses a network profile together with a custom network, and a non-boolean noResignApp', () => {
    expect(() => browserstack({ ...options, networkProfile: '3g', customNetwork: '1000' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'browserstack: set `networkProfile` or `customNetwork`, not both' }),
    );
    expect(() => browserstack({ ...options, noResignApp: 'yes' } as unknown as BrowserStackOptions)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'browserstack: `noResignApp` must be a boolean, not "yes"' }),
    );
  });

  it('has BrowserStack fetch an https build once per run and leases every slot with its bs:// id', async () => {
    const provider = browserstack({ ...options, app: 'https://example.com/app.apk' });
    const req = request();
    await Promise.all([provider.acquire(req), provider.acquire(request({ slot: 1 }))]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith('https://api-cloud.browserstack.com/app-automate', { username: 'ada', accessKey: 'bs-key' }, 'https://example.com/app.apk', req.signal);
    expect([driver(0).allocate.providerApp, driver(1).allocate.providerApp]).toEqual(['bs://UPLOADED', 'bs://UPLOADED']);
    expect(req.lines).toContain('uploaded the app URL as bs://UPLOADED');
    expect(req.lines.join('\n')).not.toContain('example.com');
  });

  it('starts no daemon when the upload fails, and uploads again on the next lease', async () => {
    const provider = browserstack({ ...options, app: 'https://example.com/app.apk' });
    mocks.upload.mockRejectedValueOnce(new Error('BrowserStack app upload from a URL failed: HTTP 422 (Invalid file)'));
    await expect(provider.acquire(request())).rejects.toThrow('HTTP 422 (Invalid file)');
    expect(mocks.start).not.toHaveBeenCalled();
    await provider.acquire(request());
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(driver().allocate.providerApp).toBe('bs://UPLOADED');
  });

  it('passes a bs:// id or a local path through without uploading', async () => {
    await browserstack(options).acquire(request());
    await browserstack({ ...options, app: 'build/app.apk' }).acquire(request());
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
