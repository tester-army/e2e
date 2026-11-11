/**
 * `revyl()` against a stubbed `@e2e-dev/mobile/lease`: the options it
 * refuses, and the selectors, credentials, and plugin home it leases with.
 * The lease lifecycle is `@e2e-dev/mobile`'s, tested there.
 */

import { join } from 'node:path';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import type { AgentDeviceLeaseOptions, AgentDeviceLeaseRequest } from '@e2e-dev/mobile/lease';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revyl, type RevylOptions } from '../../src/index.ts';

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
const env = { REVYL_API_KEY: 'revyl-key', PATH: '/bin' };
const options: RevylOptions = { app: 'https://builds.example.com/app.apk', device: 'Pixel 7' };

beforeEach(() => {
  vi.clearAllMocks();
  let leases = 0;
  mocks.acquire.mockImplementation(async (_request: DeviceRequest, { selectors }: AgentDeviceLeaseRequest): Promise<DeviceLease> => ({ id: `lease-${++leases}`, client: { ...selectors } }));
});

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    platform: 'android',
    runId: 'run-1',
    targetName: 'android',
    slot: 0,
    slots: 2,
    app: 'com.example.app',
    agentDeviceVersion: '0.21.36',
    projectRoot: ROOT,
    env,
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

const context: DeviceReleaseContext = { runId: 'run-1', targetName: 'android', env, signal: new AbortController().signal, log: () => undefined };

const leased = (call = 0) => mocks.acquire.mock.calls[call]![1] as AgentDeviceLeaseRequest;

describe('revyl()', () => {
  it("is a device provider named revyl that leases through agent-device's revyl plugin", () => {
    const provider = revyl(options);
    expect(provider.name).toBe('revyl');
    expect(mocks.leases).toHaveBeenCalledWith({ provider: 'revyl', label: 'Revyl' });
  });

  it("checks the plugin against the engine's agent-device before anything starts", async () => {
    mocks.version.mockImplementationOnce(() => {
      throw new Error('@e2e-dev/revyl uses @agent-device/revyl 0.21.36, but @e2e-dev/mobile uses agent-device 0.21.40. Install matching versions.');
    });
    await expect(revyl(options).acquire(request({ agentDeviceVersion: '0.21.40' }))).rejects.toThrow(/Install matching versions/);
    expect(mocks.version).toHaveBeenCalledWith('0.21.40');
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("leases with the device and app selectors, the run's API key, the plugin in the daemon's home, and a summary", async () => {
    const provider = revyl(options);
    const req = request();
    const lease = await provider.acquire(req);
    expect(mocks.acquire).toHaveBeenCalledWith(req, expect.anything());
    expect(leased()).toEqual({
      env: { REVYL_API_KEY: 'revyl-key' },
      summary: 'Pixel 7, android; Revyl device started',
      prepareHome: mocks.install,
      selectors: { device: 'Pixel 7', providerApp: 'https://builds.example.com/app.apk' },
    });
    await provider.release(lease, context);
    expect(mocks.release).toHaveBeenCalledWith(lease, context);
  });

  it('leaves the model off the lease the worker selects its device with, since the plugin names the started device itself', async () => {
    const lease = await revyl(options).acquire(request());
    expect(lease).toEqual({ id: 'lease-1', client: { providerApp: 'https://builds.example.com/app.apk' } });
  });

  it('leases an iOS device with its OS version, and passes a REVYL_API_URL override to the daemon', async () => {
    await revyl({ app: 'https://builds.example.com/App.zip', device: 'iPhone 17 Pro Max', osVersion: 'iOS 27.0' }).acquire(
      request({ platform: 'ios', env: { ...env, REVYL_API_URL: ' https://backend-staging.revyl.ai ' } }),
    );
    expect(leased()).toMatchObject({
      env: { REVYL_API_KEY: 'revyl-key', REVYL_API_URL: 'https://backend-staging.revyl.ai' },
      summary: 'iPhone 17 Pro Max, ios iOS 27.0; Revyl device started',
      selectors: { device: 'iPhone 17 Pro Max', providerApp: 'https://builds.example.com/App.zip', providerOsVersion: 'iOS 27.0' },
    });
  });

  it.each([{}, { REVYL_API_KEY: '  ' }])("leases nothing without REVYL_API_KEY in the run's environment (%j)", async (runEnv) => {
    await expect(revyl(options).acquire(request({ env: runEnv }))).rejects.toThrow('REVYL_API_KEY is not set; set it to a Revyl API key in the environment `e2e run` starts in');
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("refuses the target's app.appPath, since Revyl installs `app`", async () => {
    await expect(revyl(options).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }))).rejects.toThrow("Revyl installs the app from `app`; leave the target's `app.appPath` out");
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('rejects an option it does not take with INVALID_CONFIG, naming the nearest one', () => {
    expect(() => revyl({ ...options, osVerison: '14' } as unknown as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('osVersion') }));
    expect(() => revyl({ ...options, deviceType: 'real' } as unknown as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it.each(['app', 'device'] as const)('requires `%s` with INVALID_CONFIG', (key) => {
    expect(() => revyl({ ...options, [key]: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: `revyl: \`${key}\` is required, as a non-empty string` }));
    const { [key]: _, ...rest } = options;
    expect(() => revyl(rest as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it.each([' ', 14, null])('refuses an empty or non-string `osVersion` with INVALID_CONFIG (%j)', (osVersion) => {
    expect(() => revyl({ ...options, osVersion } as unknown as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'revyl: `osVersion` must be a non-empty string' }));
  });

  it.each(['build/app.apk', '/builds/app.apk', 'http://builds.example.com/app.apk', 'https://user:pass@builds.example.com/app.apk', 'lt://APP123'])(
    'refuses an app Revyl cannot download over https (%s)',
    (app) => {
      expect(() => revyl({ ...options, app })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: `revyl: \`app\` must be an https URL Revyl can download the build from, not ${JSON.stringify(app)}` }),
      );
    },
  );
});
