/**
 * The device provider seam through the engine contract, with a scripted
 * provider and client: leases per slot, the hand-off to workers, the daemon
 * each worker drives, the install skip, and release on every path.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceLease, DeviceProvider, DeviceRequest } from '../../src/provider.ts';
import { boot, harness, poolVariableIn, PROJECT_ROOT } from '../helpers/harness.ts';

/** A scripted provider: leases `lease-n` against `https://n.example`, remembering every call. */
function provider(options: { failSlot?: number; installedApp?: string; failRelease?: boolean } = {}) {
  const acquired: DeviceRequest[] = [];
  const released: DeviceLease[] = [];
  const impl: DeviceProvider = {
    name: 'toy-cloud',
    async acquire(request) {
      acquired.push(request);
      if (request.slot === options.failSlot) throw new Error(`no capacity for slot ${request.slot}`);
      request.log('starting');
      return {
        id: `lease-${request.slot}`,
        daemon: { baseUrl: `https://${request.slot}.example`, authToken: `token-${request.slot}` },
        device: `sim-${request.slot}`,
        ...(options.installedApp === undefined ? {} : { installedApp: options.installedApp }),
      };
    },
    async release(lease) {
      released.push(lease);
      if (options.failRelease === true) throw new Error('stop failed');
    },
  };
  return { impl, acquired, released };
}

const prepareInfo = (env: NodeJS.ProcessEnv, slots: number, log: (line: string) => void = () => undefined) => ({
  runId: 'run-1',
  targetName: 'ios',
  projectRoot: PROJECT_ROOT,
  slots,
  env,
  signal: new AbortController().signal,
  log,
});
const finishInfo = (log: (line: string) => void = () => undefined) => ({
  runId: 'run-1',
  targetName: 'ios',
  env: {},
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  log,
});

describe('device provider', () => {
  it('rejects a provider without a name or the two methods', () => {
    expect(() => harness({ device: { name: '' } as unknown as DeviceProvider })).toThrow(/non-empty `name`/);
    expect(() => harness({ device: { name: 'x', acquire: async () => ({}) } as unknown as DeviceProvider })).toThrow(
      /provider "x" must implement release\(\)/,
    );
  });

  it('leases one device per slot at prepare, warms each through its own daemon, and hands the bindings to the workers', async () => {
    const cloud = provider();
    const h = harness({ device: cloud.impl });
    // A provider serves as many workers as the run has slots; the cap is only known once leased.
    expect(h.engine.workers).toBeUndefined();
    const lines: string[] = [];
    const result = await h.engine.prepare!(prepareInfo({ DEVICE_SERVICE_TOKEN: 't' }, 2, (line) => lines.push(line)));
    expect(result?.workers).toBe(2);
    expect(cloud.acquired.map((request) => [request.slot, request.slots, request.platform, request.app, request.appPath])).toEqual([
      [0, 2, 'ios', 'Settings', undefined],
      [1, 2, 'ios', 'Settings', undefined],
    ]);
    expect(cloud.acquired[0]!.env).toEqual({ DEVICE_SERVICE_TOKEN: 't' });
    expect(lines).toEqual([
      'leasing 2 ios device(s) from toy-cloud',
      'toy-cloud (1 of 2): starting',
      'toy-cloud (2 of 2): starting',
      'toy-cloud: leased lease-0 (sim-0)',
      'toy-cloud: leased lease-1 (sim-1)',
      'booting sim-0 (1 of 2)',
      'booting sim-1 (2 of 2)',
    ]);
    // Warmed like a local device, through the leased daemon: a fresh hosted simulator is the coldest device there is.
    expect(h.connections.map((connection) => connection?.daemon)).toEqual([
      { baseUrl: 'https://0.example', authToken: 'token-0' },
      { baseUrl: 'https://1.example', authToken: 'token-1' },
    ]);
    expect(h.fake.methods()).toEqual(['devices.boot', 'apps.open', 'devices.boot', 'apps.open']);
    expect(h.fake.calls[1]!.args).toEqual({ app: 'Settings', platform: 'ios', device: 'sim-0' });
    const handed = result?.env ?? {};
    const variable = poolVariableIn(handed, 'IOS');
    expect(JSON.parse(handed[variable]!)).toEqual([
      { device: 'sim-0', daemon: { baseUrl: 'https://0.example', authToken: 'token-0' } },
      { device: 'sim-1', daemon: { baseUrl: 'https://1.example', authToken: 'token-1' } },
    ]);

    // A child worker reads its binding from the environment and drives that daemon and device.
    const worker = harness({ device: cloud.impl });
    await boot(worker.engine, 'ios', 1, { [variable]: handed[variable] });
    expect(worker.connections.map((connection) => connection?.daemon)).toEqual([{ baseUrl: 'https://1.example', authToken: 'token-1' }]);
    expect(worker.sessions).toEqual(['e2e-ios-1']);
    expect(worker.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'sim-1' });

    // The runner-side handle reads its own bindings and releases the leases at finish.
    await boot(h.engine, 'ios', 0);
    expect(h.connections.at(-1)?.daemon).toEqual({ baseUrl: 'https://0.example', authToken: 'token-0' });
    const finished: string[] = [];
    await h.engine.finish!(finishInfo((line) => finished.push(line)));
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
    expect(finished).toEqual(['toy-cloud: released 2 device(s)']);
    // Nothing left: a second finish releases nothing.
    await h.engine.finish!(finishInfo());
    expect(cloud.released).toHaveLength(2);
  });

  it('asks the provider for the resolved build and installs it in the worker when the lease did not', async () => {
    const cloud = provider();
    const h = harness({ device: cloud.impl, appPath: 'build/App.app' });
    const result = await h.engine.prepare!(prepareInfo({}, 1));
    expect(cloud.acquired[0]!.appPath).toBe(path.join(PROJECT_ROOT, 'build/App.app'));
    // The build is not on the device yet: warm-up boots only.
    expect(h.fake.methods()).toEqual(['devices.boot']);
    const handed = result?.env ?? {};
    const worker = harness({ device: cloud.impl, appPath: 'build/App.app' });
    await boot(worker.engine, 'ios', 0, handed);
    expect(worker.fake.lastArgs('apps.install')).toMatchObject({ device: 'sim-0', appPath: path.join(PROJECT_ROOT, 'build/App.app') });
  });

  it('skips the build install when the lease says the provider installed it, and opens that app', async () => {
    const cloud = provider({ installedApp: 'com.example.app' });
    const h = harness({ device: cloud.impl, appPath: 'build/App.app' }, false);
    await h.engine.prepare!(prepareInfo({}, 1));
    // Installed by the provider: warm-up opens it right away.
    expect(h.fake.methods()).toEqual(['devices.boot', 'apps.open']);
    expect(h.fake.lastArgs('apps.open')).toEqual({ app: 'com.example.app', platform: 'ios', device: 'sim-0' });
    await boot(h.engine, 'ios', 0);
    expect(h.fake.methods().filter((method) => method === 'apps.install')).toEqual([]);
    await h.engine.startAttempt!({ attemptId: 'a1', artifactsDir: '', signal: new AbortController().signal });
    expect(h.fake.lastArgs('apps.open')).toMatchObject({ app: 'com.example.app', device: 'sim-0', relaunch: true });
  });

  it('rejects a lease that reports an installed app for a request without appPath', async () => {
    const cloud = provider({ installedApp: 'com.example.app' });
    const h = harness({ device: cloud.impl });
    await expect(h.engine.prepare!(prepareInfo({}, 1))).rejects.toMatchObject({
      message: expect.stringContaining('reported an installed app for a request without `appPath`'),
    });
    // The lease was granted, so it is still released.
    await h.engine.finish!(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });

  it('rejects a lease whose installed app is a link, before the pool opens it on the device', async () => {
    const cloud = provider({ installedApp: 'file:///etc/passwd' });
    const h = harness({ device: cloud.impl, appPath: 'build/App.app' }, false);
    await expect(h.engine.prepare!(prepareInfo({}, 1))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('reported an installed app that is a link'),
    });
    expect(h.fake.methods()).toEqual([]);
    await h.engine.finish!(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });

  it('leases nothing for a target with no slots', async () => {
    const cloud = provider();
    const h = harness({ device: cloud.impl });
    expect(await h.engine.prepare!(prepareInfo({}, 0))).toEqual({});
    expect(cloud.acquired).toEqual([]);
    await h.engine.finish!(finishInfo());
    expect(cloud.released).toEqual([]);
  });

  it('hands the workers only the declared lease fields and gives release the provider\'s own object back', async () => {
    const acquiredLeases: DeviceLease[] = [];
    const releasedLeases: DeviceLease[] = [];
    const bookkeeping: DeviceProvider = {
      name: 'notes',
      async acquire(request) {
        const lease = { id: `l-${request.slot}`, daemon: { baseUrl: 'https://d.example' }, session: { secret: 'x'.repeat(100) } };
        acquiredLeases.push(lease);
        return lease;
      },
      async release(lease) {
        releasedLeases.push(lease);
      },
    };
    const h = harness({ device: bookkeeping });
    const result = await h.engine.prepare!(prepareInfo({}, 1));
    const handed = result?.env ?? {};
    expect(JSON.parse(handed[poolVariableIn(handed, 'IOS')]!)).toEqual([{ daemon: { baseUrl: 'https://d.example' } }]);
    await h.engine.finish!(finishInfo());
    expect(releasedLeases).toEqual(acquiredLeases);
  });

  it('carries client configuration to the worker next to the daemon, and accepts a lease with only that', async () => {
    const scope = { stateDir: '/tmp/devices', tenant: 'cloud', runId: 'run-1', leaseId: 'lease-0', leaseBackend: 'ios-instance', leaseProvider: 'cloud' } as const;
    const scoped: DeviceProvider = {
      name: 'scoped',
      async acquire(request) {
        return request.slot === 0
          ? { id: 'l-0', client: scope }
          : { id: 'l-1', daemon: { baseUrl: 'https://1.example' }, client: { providerOsVersion: '18.0' } };
      },
      async release() {},
    };
    const h = harness({ device: scoped });
    const result = await h.engine.prepare!(prepareInfo({}, 2));
    // Warm-up already drives each device with its lease's configuration.
    expect(h.connections).toEqual([
      { client: scope },
      { daemon: { baseUrl: 'https://1.example' }, client: { providerOsVersion: '18.0' } },
    ]);
    const handed = result?.env ?? {};
    const variable = poolVariableIn(handed, 'IOS');
    expect(JSON.parse(handed[variable]!)).toEqual([
      { client: scope },
      { daemon: { baseUrl: 'https://1.example' }, client: { providerOsVersion: '18.0' } },
    ]);
    const worker = harness({ device: scoped });
    await boot(worker.engine, 'ios', 0, { [variable]: handed[variable] });
    expect(worker.connections).toEqual([{ client: scope }]);
  });

  it('refuses a lease that names neither a daemon nor client configuration, or a client with reserved keys', async () => {
    for (const lease of [
      { id: 'bare' },
      { id: 'session', client: { session: 'mine', leaseId: 'x' } },
      { id: 'daemon-keys', client: { daemonBaseUrl: 'https://d.example' } },
      { id: 'transport', client: { leaseId: 'x', daemonTransport: 'http' } },
      { id: 'not-json', client: { leaseId: 'x', onReady: () => undefined } },
      { id: 'nan', client: { leaseId: 'x', leaseTtlMs: Number.NaN } },
      { id: 'infinity', client: { leaseId: 'x', leaseTtlMs: Number.POSITIVE_INFINITY } },
      { id: 'negative-infinity', client: { leaseId: 'x', leaseTtlMs: Number.NEGATIVE_INFINITY } },
    ]) {
      const h = harness({ device: { name: 'odd', acquire: async () => lease as unknown as DeviceLease, release: async () => {} } });
      await expect(h.engine.prepare!(prepareInfo({}, 1))).rejects.toMatchObject({
        message: expect.stringContaining('returned a lease without an id and a daemon baseUrl or JSON client configuration'),
      });
    }
  });

  it('rejects bindings too large for a worker environment, by bytes', async () => {
    const oversized: DeviceProvider = {
      name: 'huge',
      async acquire(request) {
        // Multi-byte characters: the cap is on bytes, not string length.
        return { id: `l-${request.slot}`, daemon: { baseUrl: 'https://d.example', authToken: 'ż'.repeat(9_000) } };
      },
      async release() {},
    };
    const h = harness({ device: oversized });
    await expect(h.engine.prepare!(prepareInfo({}, 1))).rejects.toMatchObject({
      message: expect.stringContaining('the worker environment carries at most 16384'),
    });
  });

  it('holds the slots that leased when another fails, so finish releases them, and fails the run before any test', async () => {
    const cloud = provider({ failSlot: 1 });
    const h = harness({ device: cloud.impl });
    await expect(h.engine.prepare!(prepareInfo({}, 2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('device provider "toy-cloud" could not lease a device: no capacity for slot 1'),
    });
    await h.engine.finish!(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });

  it('treats an acquire that throws before its first await like any other failed slot', async () => {
    const sync: DeviceProvider = {
      name: 'sync',
      acquire(request) {
        if (request.slot === 1) throw new Error('token missing');
        return Promise.resolve({ id: `l-${request.slot}`, daemon: { baseUrl: 'https://d.example' } });
      },
      async release() {},
    };
    const h = harness({ device: sync });
    await expect(h.engine.prepare!(prepareInfo({}, 2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('could not lease a device: token missing'),
    });
  });

  it('reports a release failure once every lease was tried, and a slot outside the leases as an engine defect', async () => {
    const cloud = provider({ failRelease: true });
    const h = harness({ device: cloud.impl });
    await h.engine.prepare!(prepareInfo({}, 2));
    await expect(h.engine.finish!(finishInfo())).rejects.toMatchObject({
      message: expect.stringContaining('could not release a device: stop failed'),
    });
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);

    const again = harness({ device: cloud.impl });
    await again.engine.prepare!(prepareInfo({}, 1));
    await expect(boot(again.engine, 'ios', 1)).rejects.toMatchObject({
      message: expect.stringContaining('worker slot 1 is outside a device pool of 1'),
    });
  });

  it('without a prepared lease a provider-backed worker falls back to the local daemon, and finish has nothing to release', async () => {
    const cloud = provider();
    const h = harness({ device: cloud.impl });
    await boot(h.engine, 'ios', 0);
    expect(h.connections).toEqual([undefined]);
    expect(h.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios' });
    await h.engine.finish!(finishInfo());
    expect(cloud.released).toEqual([]);
  });
});
