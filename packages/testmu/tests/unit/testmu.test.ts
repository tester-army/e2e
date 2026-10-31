/**
 * `testmu()` against a stubbed `@e2e-dev/mobile/lease`: the options it
 * refuses, the selectors, credentials, and plugin home it leases with. The
 * lease lifecycle is `@e2e-dev/mobile`'s, tested there. `recording.test.ts`
 * covers `record`.
 */

import { join } from 'node:path';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import type { AgentDeviceLeaseOptions, AgentDeviceLeaseRequest } from '@e2e-dev/mobile/lease';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testmu, type TestmuOptions } from '../../src/index.ts';

const mocks = vi.hoisted(() => ({
  version: vi.fn(),
  install: vi.fn(async (_home: string) => {}),
  leases: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock('../../src/daemon.ts', () => ({ assertPluginVersion: mocks.version, installPlugin: mocks.install }));
vi.mock('@e2e-dev/mobile/lease', () => ({
  agentDeviceLeases: (options: AgentDeviceLeaseOptions) => {
    mocks.leases(options);
    return { acquire: mocks.acquire, release: mocks.release };
  },
}));

const ROOT = '/project';
const env = { LT_USERNAME: 'ada', LT_ACCESS_KEY: 'lt-key', PATH: '/bin' };
const options: TestmuOptions = { device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'https://example.com/app.apk' };

beforeEach(() => {
  vi.clearAllMocks();
  let leases = 0;
  mocks.acquire.mockImplementation(async (_request: DeviceRequest, { selectors }: AgentDeviceLeaseRequest): Promise<DeviceLease> => ({ id: `lease-${++leases}`, client: { ...selectors } }));
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

const leased = (call = 0) => mocks.acquire.mock.calls[call]![1] as AgentDeviceLeaseRequest;
const selectors = (call = 0) => leased(call).selectors;

describe('testmu()', () => {
  it("is a device provider named testmu that leases through agent-device's testmu plugin and records TestMu AI's session video", () => {
    const provider = testmu(options);
    expect(provider.name).toBe('testmu');
    expect(provider.record).toBeTypeOf('function');
    expect(mocks.leases).toHaveBeenCalledWith({ provider: 'testmu', label: 'TestMu AI' });
  });

  it("checks the plugin against the engine's agent-device before anything starts", async () => {
    mocks.version.mockImplementationOnce(() => {
      throw new Error('@e2e-dev/testmu uses @agent-device/testmu 0.21.28, but @e2e-dev/mobile uses agent-device 0.21.30. Install matching versions.');
    });
    await expect(testmu(options).acquire(request({ agentDeviceVersion: '0.21.30' }))).rejects.toThrow(/Install matching versions/);
    expect(mocks.version).toHaveBeenCalledWith('0.21.30');
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("leases with the device selectors, dashboard labels, the run's credentials, the plugin in the daemon's home, and a summary of the session", async () => {
    const provider = testmu(options);
    const req = request({ slot: 1 });
    const lease = await provider.acquire(req);
    expect(mocks.acquire).toHaveBeenCalledWith(req, expect.anything());
    expect(leased()).toEqual({
      env: { LT_USERNAME: 'ada', LT_ACCESS_KEY: 'lt-key' },
      summary: 'Galaxy S22 Ultra 5G, android 14 (virtual); session e2e-run-1-android-2 started',
      prepareHome: mocks.install,
      selectors: {
        device: 'Galaxy S22 Ultra 5G',
        providerOsVersion: '14',
        providerApp: 'https://example.com/app.apk',
        providerDeviceType: 'virtual',
        providerProject: 'e2e',
        providerBuild: 'run-1',
        providerSessionName: 'e2e-run-1-android-2',
      },
    });
    await provider.release(lease, context);
    expect(mocks.release).toHaveBeenCalledWith(lease, context);
  });

  it('leases a real iOS device with its own project, build, and session name', async () => {
    await testmu({ device: 'iPhone 16', osVersion: '18', app: 'lt://APP123', deviceType: 'real', project: 'shop', build: 'nightly', sessionName: 'checkout' }).acquire(request({ platform: 'ios' }));
    expect(selectors()).toEqual({
      device: 'iPhone 16',
      providerOsVersion: '18',
      providerApp: 'lt://APP123',
      providerDeviceType: 'real',
      providerProject: 'shop',
      providerBuild: 'nightly',
      providerSessionName: 'checkout-1',
    });
  });

  it("names each slot's session after the run, the target, and the slot, and keeps a given name unique per slot", async () => {
    const provider = testmu(options);
    await provider.acquire(request({ runId: 'run-7', targetName: 'pixel', slot: 0, slots: 3 }));
    await provider.acquire(request({ runId: 'run-7', targetName: 'pixel', slot: 2, slots: 3 }));
    await testmu({ ...options, sessionName: 'checkout' }).acquire(request({ slot: 2, slots: 3 }));
    await testmu({ ...options, sessionName: 'checkout' }).acquire(request({ slot: 0, slots: 1 }));
    expect(mocks.acquire.mock.calls.map(([, call]) => (call as AgentDeviceLeaseRequest).selectors.providerSessionName)).toEqual(['e2e-run-7-pixel-1', 'e2e-run-7-pixel-3', 'checkout-3', 'checkout']);
  });

  it("passes the device features to the allocation and the worker under agent-device's keys", async () => {
    const lease = await testmu({ ...options, orientation: 'landscape', geoLocation: 'US', timezone: 'UTC+05:30', language: 'fr', locale: 'fr_FR', appiumVersion: '2.16.2' }).acquire(request());
    const features = {
      providerDeviceOrientation: 'landscape',
      providerGeoLocation: 'US',
      providerTimezone: 'UTC+05:30',
      providerLanguage: 'fr',
      providerLocale: 'fr_FR',
      providerAppiumVersion: '2.16.2',
    };
    expect(selectors()).toMatchObject(features);
    expect(lease.client).toMatchObject(features);
  });

  it('resolves a local build against the project root, never the working directory', async () => {
    await testmu({ ...options, app: 'build/app.apk' }).acquire(request());
    expect(selectors(0).providerApp).toBe(join(ROOT, 'build', 'app.apk'));
    await testmu({ ...options, app: join('/', 'builds', 'app.apk') }).acquire(request());
    expect(selectors(1).providerApp).toBe(join('/', 'builds', 'app.apk'));
  });

  it.each([
    [{}, 'LT_USERNAME and LT_ACCESS_KEY are not set'],
    [{ LT_USERNAME: 'ada' }, 'LT_ACCESS_KEY is not set'],
    [{ LT_USERNAME: '  ', LT_ACCESS_KEY: 'lt-key' }, 'LT_USERNAME is not set'],
  ])("leases nothing without credentials in the run's environment (%j)", async (runEnv, message) => {
    await expect(testmu(options).acquire(request({ env: runEnv }))).rejects.toThrow(
      `${message}; set LT_USERNAME and LT_ACCESS_KEY to your TestMu AI username and access key in the environment \`e2e run\` starts in`,
    );
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("refuses the target's app.appPath, since TestMu AI installs `app`", async () => {
    await expect(testmu(options).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }))).rejects.toThrow("TestMu AI installs the app from `app`; leave the target's `app.appPath` out");
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('rejects an option it does not take with INVALID_CONFIG, naming the nearest one', () => {
    expect(() => testmu({ ...options, osVerison: '14' } as unknown as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('osVersion') }));
    expect(() => testmu({ ...options, stateDir: '.e2e' } as unknown as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it.each(['device', 'osVersion', 'app'] as const)('requires `%s` with INVALID_CONFIG', (key) => {
    expect(() => testmu({ ...options, [key]: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: `testmu: \`${key}\` is required, as a non-empty string` }));
    const { [key]: _, ...rest } = options;
    expect(() => testmu(rest as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('refuses an orientation other than portrait or landscape', () => {
    expect(() => testmu({ ...options, orientation: 'PORTRAIT' as 'portrait' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'testmu: `orientation` must be \'portrait\' or \'landscape\', not "PORTRAIT"' }),
    );
  });

  it.each(['orientation', 'geoLocation', 'timezone', 'language', 'locale', 'appiumVersion'] as const)('refuses an empty or non-string `%s` with INVALID_CONFIG', (key) => {
    expect(() => testmu({ ...options, [key]: ' ' } as unknown as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: `testmu: \`${key}\` must be a non-empty string` }));
    expect(() => testmu({ ...options, [key]: 2 } as unknown as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => testmu({ ...options, [key]: null } as unknown as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it.each(['emulator', null])('refuses a device type other than virtual or real (%j)', (deviceType) => {
    expect(() => testmu({ ...options, deviceType } as unknown as TestmuOptions)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: `testmu: \`deviceType\` must be 'virtual' or 'real', not ${JSON.stringify(deviceType)}` }),
    );
  });

  it.each(['project', 'build', 'sessionName'] as const)('refuses an empty or non-string `%s` with INVALID_CONFIG', (key) => {
    for (const value of [' ', 1, null]) {
      expect(() => testmu({ ...options, [key]: value } as unknown as TestmuOptions)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: `testmu: \`${key}\` must be a non-empty string` }),
      );
    }
  });
});
