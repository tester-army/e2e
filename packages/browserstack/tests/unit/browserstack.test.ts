/**
 * `browserstack()` against a stubbed `@e2e-dev/mobile/lease`: the options it
 * refuses, the selectors and credentials it leases with, and the app upload.
 * The lease lifecycle is `@e2e-dev/mobile`'s, tested there.
 * `recording.test.ts` covers `record`.
 */

import { join } from 'node:path';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import type { AgentDeviceLeaseOptions, AgentDeviceLeaseRequest } from '@e2e-dev/mobile/lease';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserstack, type BrowserStackOptions } from '../../src/index.ts';

const mocks = vi.hoisted(() => ({
  leases: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  upload: vi.fn(async (_endpoint: string, _credentials: unknown, _url: string, _signal: AbortSignal) => 'bs://UPLOADED'),
}));
vi.mock('@e2e-dev/mobile/lease', () => ({
  agentDeviceLeases: (options: AgentDeviceLeaseOptions) => {
    mocks.leases(options);
    return { acquire: mocks.acquire, release: mocks.release };
  },
}));
vi.mock('../../src/sessions.ts', async (original) => ({ ...(await original<typeof import('../../src/sessions.ts')>()), uploadAppFromUrl: mocks.upload }));

const ROOT = '/project';
const env = { BROWSERSTACK_USERNAME: 'ada', BROWSERSTACK_ACCESS_KEY: 'bs-key', PATH: '/bin' };
const options: BrowserStackOptions = { device: 'Google Pixel 9', osVersion: '16.0', app: 'bs://APP0' };

beforeEach(() => {
  vi.clearAllMocks();
  let leases = 0;
  mocks.acquire.mockImplementation(async (_request: DeviceRequest, { selectors }: AgentDeviceLeaseRequest): Promise<DeviceLease> => ({ id: `lease-${++leases}`, client: { ...selectors } }));
  // A test that fails before using its queued answers must not hand them to the next one.
  mocks.upload.mockReset().mockResolvedValue('bs://UPLOADED');
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

describe('browserstack()', () => {
  it("is a device provider named browserstack that leases through agent-device's browserstack provider and records BrowserStack's session video", () => {
    const provider = browserstack(options);
    expect(provider.name).toBe('browserstack');
    expect(provider.record).toBeTypeOf('function');
    expect(mocks.leases).toHaveBeenCalledWith({ provider: 'browserstack', label: 'BrowserStack' });
  });

  it('leases with the device selectors, dashboard labels, the run\'s credentials, and a summary of the session', async () => {
    const provider = browserstack(options);
    const req = request({ slot: 1 });
    const lease = await provider.acquire(req);
    expect(mocks.acquire).toHaveBeenCalledWith(req, expect.anything());
    expect(leased()).toEqual({
      env: { BROWSERSTACK_USERNAME: 'ada', BROWSERSTACK_ACCESS_KEY: 'bs-key' },
      summary: 'Google Pixel 9, android 16.0; session e2e-run-1-android-2 reserved',
      selectors: {
        device: 'Google Pixel 9',
        providerOsVersion: '16.0',
        providerApp: 'bs://APP0',
        providerProject: 'e2e',
        providerBuild: 'run-1',
        providerSessionName: 'e2e-run-1-android-2',
      },
    });
    await provider.release(lease, context);
    expect(mocks.release).toHaveBeenCalledWith(lease, context);
  });

  it('leases an iOS device with its own project, build, and session name', async () => {
    await browserstack({ device: 'iPhone 16', osVersion: '18', app: 'bs://APP123', project: 'shop', build: 'nightly', sessionName: 'checkout' }).acquire(request({ platform: 'ios' }));
    expect(selectors()).toEqual({
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
    expect(mocks.acquire.mock.calls.map(([, call]) => (call as AgentDeviceLeaseRequest).selectors.providerSessionName)).toEqual(['e2e-run-7-pixel-1', 'e2e-run-7-pixel-3', 'checkout-3', 'checkout']);
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
    expect(selectors()).toMatchObject(features);
    expect(lease.client).toMatchObject(features);
  });

  it('resolves a local build against the project root, never the working directory', async () => {
    await browserstack({ ...options, app: 'build/app.apk' }).acquire(request());
    expect(selectors(0).providerApp).toBe(join(ROOT, 'build', 'app.apk'));
    await browserstack({ ...options, app: join('/', 'builds', 'app.apk') }).acquire(request());
    expect(selectors(1).providerApp).toBe(join('/', 'builds', 'app.apk'));
  });

  it.each([
    [{}, 'BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY are not set'],
    [{ BROWSERSTACK_USERNAME: 'ada' }, 'BROWSERSTACK_ACCESS_KEY is not set'],
    [{ BROWSERSTACK_USERNAME: '  ', BROWSERSTACK_ACCESS_KEY: 'bs-key' }, 'BROWSERSTACK_USERNAME is not set'],
  ])("leases nothing without credentials in the run's environment (%j)", async (runEnv, message) => {
    await expect(browserstack(options).acquire(request({ env: runEnv }))).rejects.toThrow(
      `${message}; set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY to your BrowserStack username and access key in the environment \`e2e run\` starts in`,
    );
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("refuses the target's app.appPath, since BrowserStack installs `app`", async () => {
    await expect(browserstack(options).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }))).rejects.toThrow("BrowserStack installs the app from `app`; leave the target's `app.appPath` out");
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('leases nothing once the run is interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(browserstack(options).acquire(request({ signal: controller.signal }))).rejects.toThrow();
    expect(mocks.acquire).not.toHaveBeenCalled();
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
    expect(selectors(0)).toMatchObject({ providerNetworkProfile: '4g-lte-advanced-good' });
    await browserstack({ ...options, customNetwork: '1000' }).acquire(request());
    expect(selectors(1)).toMatchObject({ providerCustomNetwork: '1000' });
    await browserstack({ ...options, noResignApp: true }).acquire(request({ platform: 'ios' }));
    expect(selectors(2)).toMatchObject({ providerNoResignApp: true });
    await browserstack({ ...options, noResignApp: false }).acquire(request({ platform: 'ios' }));
    expect(selectors(3)).not.toHaveProperty('providerNoResignApp');
  });

  it('refuses noResignApp on Android before any daemon starts', async () => {
    await expect(browserstack({ ...options, noResignApp: true }).acquire(request())).rejects.toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'browserstack: `noResignApp` applies to iOS only' }));
    expect(mocks.acquire).not.toHaveBeenCalled();
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
    expect([selectors(0).providerApp, selectors(1).providerApp]).toEqual(['bs://UPLOADED', 'bs://UPLOADED']);
    expect(req.lines).toContain('uploaded the app URL as bs://UPLOADED');
    expect(req.lines.join('\n')).not.toContain('example.com');
  });

  it('keeps leasing when the run\'s log throws on the upload line', async () => {
    const provider = browserstack({ ...options, app: 'https://example.com/app.apk' });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await provider.acquire(request({ log: () => { throw new Error('log closed'); } }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(selectors().providerApp).toBe('bs://UPLOADED');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('uploads an https build again for the next run, and for another account or API endpoint', async () => {
    const provider = browserstack({ ...options, app: 'https://example.com/latest.apk' });
    mocks.upload.mockResolvedValueOnce('bs://RUN1').mockResolvedValueOnce('bs://RUN2').mockResolvedValueOnce('bs://EU').mockResolvedValueOnce('bs://BOB');
    const first = await provider.acquire(request({ runId: 'run-1' }));
    await provider.release(first, context);
    await Promise.all([provider.acquire(request({ runId: 'run-2' })), provider.acquire(request({ runId: 'run-2', slot: 1 }))]);
    await provider.acquire(request({ runId: 'run-2', env: { ...env, BROWSERSTACK_API_ENDPOINT: 'https://eu.example.com/app-automate' } }));
    await provider.acquire(request({ runId: 'run-2', env: { ...env, BROWSERSTACK_USERNAME: 'bob' } }));
    expect(mocks.upload).toHaveBeenCalledTimes(4);
    expect(mocks.acquire.mock.calls.map(([, call]) => (call as AgentDeviceLeaseRequest).selectors.providerApp)).toEqual(['bs://RUN1', 'bs://RUN2', 'bs://RUN2', 'bs://EU', 'bs://BOB']);
  });

  it('leases nothing when the upload fails, and uploads again on the next lease', async () => {
    const provider = browserstack({ ...options, app: 'https://example.com/app.apk' });
    mocks.upload.mockRejectedValueOnce(new Error('BrowserStack app upload from a URL failed: HTTP 422 (Invalid file)'));
    await expect(provider.acquire(request())).rejects.toThrow('HTTP 422 (Invalid file)');
    expect(mocks.acquire).not.toHaveBeenCalled();
    await provider.acquire(request());
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(selectors().providerApp).toBe('bs://UPLOADED');
  });

  it('leases nothing when the run is interrupted during the upload', async () => {
    const controller = new AbortController();
    mocks.upload.mockImplementationOnce(async () => {
      controller.abort();
      return 'bs://UPLOADED';
    });
    await expect(browserstack({ ...options, app: 'https://example.com/app.apk' }).acquire(request({ signal: controller.signal }))).rejects.toThrow();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('passes a bs:// id or a local path through without uploading', async () => {
    await browserstack(options).acquire(request());
    await browserstack({ ...options, app: 'build/app.apk' }).acquire(request());
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
