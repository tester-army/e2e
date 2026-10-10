/**
 * The device provider seam through the engine contract, with a scripted
 * provider and client: leases per slot, the hand-off to workers, the daemon
 * each worker drives, the install skip, release on every path, and the
 * provider's own recording of an attempt.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationContext, ProviderRecordContext, ProviderRecording, ProviderRecordingResult, ProviderRecordingStopContext } from 'e2e/engine';
import type { DeviceLease, DeviceProvider, DeviceRequest } from '../../src/provider.ts';
import { boot, harness, poolVariableIn, PROJECT_ROOT, type Harness } from '../helpers/harness.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

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
  headed: false,
  log,
});
const finishInfo = (log: (line: string) => void = () => undefined) => ({
  runId: 'run-1',
  targetName: 'ios',
  env: {},
  signal: new AbortController().signal,
  headed: false,
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
    const result = await h.prepare(prepareInfo({ DEVICE_SERVICE_TOKEN: 't' }, 2, (line) => lines.push(line)));
    expect(result?.workers).toBe(2);
    expect(cloud.acquired.map((request) => [request.slot, request.slots, request.platform, request.app, request.appPath])).toEqual([
      [0, 2, 'ios', 'Settings', undefined],
      [1, 2, 'ios', 'Settings', undefined],
    ]);
    expect(cloud.acquired[0]!.env).toEqual({ DEVICE_SERVICE_TOKEN: 't' });
    expect(cloud.acquired[0]!.projectRoot).toBe(PROJECT_ROOT);
    // The agent-device the package pins, so a provider can start a daemon of the same version.
    expect(cloud.acquired[0]!.agentDeviceVersion).toBe((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }).dependencies['agent-device']);
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
    expect(h.fake.methods()).toEqual(['devices.boot', 'command.prepare', 'apps.open', 'devices.boot', 'command.prepare', 'apps.open']);
    expect(h.fake.calls[2]!.args).toEqual({ app: 'Settings', platform: 'ios', device: 'sim-0' });
    const handed = result?.env ?? {};
    const variable = poolVariableIn(handed, 'IOS');
    expect(JSON.parse(handed[variable]!)).toEqual([
      { leaseId: 'lease-0', device: 'sim-0', daemon: { baseUrl: 'https://0.example', authToken: 'token-0' }, sessionApp: 'Settings' },
      { leaseId: 'lease-1', device: 'sim-1', daemon: { baseUrl: 'https://1.example', authToken: 'token-1' }, sessionApp: 'Settings' },
    ]);

    // A child worker reads its binding from the environment and drives that daemon and device.
    const worker = harness({ device: cloud.impl });
    await boot(worker, 'ios', 1, { [variable]: handed[variable] });
    expect(worker.connections.map((connection) => connection?.daemon)).toEqual([{ baseUrl: 'https://1.example', authToken: 'token-1' }]);
    expect(worker.sessions).toEqual(['e2e-ios-1']);
    expect(worker.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'sim-1' });

    // The runner-side handle reads its own bindings and releases the leases at finish.
    await boot(h, 'ios', 0);
    expect(h.connections.at(-1)?.daemon).toEqual({ baseUrl: 'https://0.example', authToken: 'token-0' });
    const finished: string[] = [];
    await h.engine.finish!(finishInfo((line) => finished.push(line)));
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
    expect(finished).toEqual(['toy-cloud: released 2 device(s)']);
    // Nothing left: a second finish releases nothing.
    await h.engine.finish!(finishInfo());
    expect(cloud.released).toHaveLength(2);
  });

  it('asks the provider for the resolved build and leaves the install to the suite when the lease did not', async () => {
    const cloud = provider();
    const h = harness({ device: cloud.impl, appPath: 'build/App.app' });
    const result = await h.prepare(prepareInfo({}, 1));
    expect(cloud.acquired[0]!.appPath).toBe(path.join(PROJECT_ROOT, 'build/App.app'));
    // The lease installed nothing: the build is not on the device, so warm-up boots and starts the runner only, and the worker installs nothing.
    expect(h.fake.methods()).toEqual(['devices.boot', 'command.prepare']);
    const handed = result?.env ?? {};
    const worker = harness({ device: cloud.impl, appPath: 'build/App.app' });
    await boot(worker, 'ios', 0, handed);
    expect(worker.fake.methods()).toEqual(['devices.boot']);
    await worker.surface.installApp(undefined, {}, new AbortController().signal);
    expect(worker.fake.lastArgs('apps.install')).toMatchObject({ device: 'sim-0', app: 'Settings', appPath: path.join(PROJECT_ROOT, 'build/App.app') });
  });

  it('skips the build install when the lease says the provider installed it, and opens that app', async () => {
    const cloud = provider({ installedApp: 'com.example.app' });
    const h = harness({ device: cloud.impl, appPath: 'build/App.app' }, false);
    await h.prepare(prepareInfo({}, 1));
    // Installed by the provider: warm-up opens it right away.
    expect(h.fake.methods()).toEqual(['devices.boot', 'command.prepare', 'apps.open']);
    expect(h.fake.lastArgs('apps.open')).toEqual({ app: 'com.example.app', platform: 'ios', device: 'sim-0' });
    await boot(h, 'ios', 0);
    expect(h.fake.methods().filter((method) => method === 'apps.install')).toEqual([]);
    await h.engine.startAttempt!({ attemptId: 'a1', artifactsDir: '', signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await h.engine.session!.restart!({ signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1', origin: 'test' });
    expect(h.fake.lastArgs('apps.open')).toMatchObject({ app: 'com.example.app', device: 'sim-0', relaunch: true });
  });

  it('rejects a lease that reports an installed app for a request without appPath', async () => {
    const cloud = provider({ installedApp: 'com.example.app' });
    const h = harness({ device: cloud.impl });
    await expect(h.prepare(prepareInfo({}, 1))).rejects.toMatchObject({
      message: expect.stringContaining('reported an installed app for a request without `appPath`'),
    });
    // The lease was granted, so it is still released.
    await h.engine.finish!(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });

  it('rejects a lease whose installed app is a link, before the pool opens it on the device', async () => {
    const cloud = provider({ installedApp: 'file:///etc/passwd' });
    const h = harness({ device: cloud.impl, appPath: 'build/App.app' }, false);
    await expect(h.prepare(prepareInfo({}, 1))).rejects.toMatchObject({
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
    expect(await h.prepare(prepareInfo({}, 0))).toEqual({});
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
        // A provider may keep a `leaseId` of its own on the lease; the worker's comes from `id`.
        const lease = { id: `l-${request.slot}`, leaseId: 42, daemon: { baseUrl: 'https://d.example' }, session: { secret: 'x'.repeat(100) } };
        acquiredLeases.push(lease);
        return lease;
      },
      async release(lease) {
        releasedLeases.push(lease);
      },
    };
    const h = harness({ device: bookkeeping });
    const result = await h.prepare(prepareInfo({}, 1));
    const handed = result?.env ?? {};
    expect(JSON.parse(handed[poolVariableIn(handed, 'IOS')]!)).toEqual([{ leaseId: 'l-0', daemon: { baseUrl: 'https://d.example' }, sessionApp: 'Settings' }]);
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
    const result = await h.prepare(prepareInfo({}, 2));
    // Warm-up already drives each device with its lease's configuration.
    expect(h.connections).toEqual([
      { leaseId: 'l-0', client: scope },
      { leaseId: 'l-1', daemon: { baseUrl: 'https://1.example' }, client: { providerOsVersion: '18.0' } },
    ]);
    const handed = result?.env ?? {};
    const variable = poolVariableIn(handed, 'IOS');
    expect(JSON.parse(handed[variable]!)).toEqual([
      { leaseId: 'l-0', client: scope, sessionApp: 'Settings' },
      { leaseId: 'l-1', daemon: { baseUrl: 'https://1.example' }, client: { providerOsVersion: '18.0' }, sessionApp: 'Settings' },
    ]);
    const worker = harness({ device: scoped });
    await boot(worker, 'ios', 0, { [variable]: handed[variable] });
    expect(worker.connections.map((connection) => connection?.client)).toEqual([scope]);
  });

  it('refuses a lease that names neither a daemon nor client configuration, or a client with reserved keys, and still releases it', async () => {
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
      const released: DeviceLease[] = [];
      const odd: DeviceProvider = {
        name: 'odd',
        acquire: async () => lease as unknown as DeviceLease,
        release: async (granted) => {
          released.push(granted);
        },
      };
      const h = harness({ device: odd });
      await expect(h.prepare(prepareInfo({}, 1))).rejects.toMatchObject({
        message: expect.stringContaining('returned a lease without an id and a daemon baseUrl or JSON client configuration'),
      });
      // The provider allocated a device for it, so it is billed until released: finish hands back the very object.
      await h.engine.finish!(finishInfo());
      expect(released).toHaveLength(1);
      expect(released[0]).toBe(lease);
    }
  });

  it('has nothing to release for a lease without an id', async () => {
    const released: DeviceLease[] = [];
    const nameless: DeviceProvider = {
      name: 'nameless',
      acquire: async () => ({ daemon: { baseUrl: 'https://d.example' } }) as unknown as DeviceLease,
      release: async (granted) => {
        released.push(granted);
      },
    };
    const h = harness({ device: nameless });
    await expect(h.prepare(prepareInfo({}, 1))).rejects.toMatchObject({
      message: expect.stringContaining('returned a lease without an id and a daemon baseUrl or JSON client configuration'),
    });
    await h.engine.finish!(finishInfo());
    expect(released).toEqual([]);
  });

  it('releases a good lease and a rejected one from the same prepare, and warms neither', async () => {
    const bad = { id: 'bad' };
    const released: DeviceLease[] = [];
    const mixed: DeviceProvider = {
      name: 'mixed',
      acquire: async (request) =>
        request.slot === 0 ? { id: 'lease-0', daemon: { baseUrl: 'https://0.example' }, device: 'sim-0' } : (bad as DeviceLease),
      release: async (granted) => {
        released.push(granted);
      },
    };
    const h = harness({ device: mixed });
    await expect(h.prepare(prepareInfo({}, 2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('returned a lease without an id and a daemon baseUrl or JSON client configuration'),
    });
    // The bind failed before the warm-up, so no device was booted or opened, and nothing is left to close.
    expect(h.fake.methods()).toEqual([]);
    await h.engine.finish!(finishInfo());
    expect(released.map((lease) => lease.id)).toEqual(['lease-0', 'bad']);
    expect(released[1]).toBe(bad);
    expect(h.fake.methods()).toEqual([]);
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
    await expect(h.prepare(prepareInfo({}, 1))).rejects.toMatchObject({
      message: expect.stringContaining('the worker environment carries at most 16384'),
    });
  });

  it('holds the slots that leased when another fails, so finish releases them, and fails the run before any test', async () => {
    const cloud = provider({ failSlot: 1 });
    const h = harness({ device: cloud.impl });
    await expect(h.prepare(prepareInfo({}, 2))).rejects.toMatchObject({
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
    await expect(h.prepare(prepareInfo({}, 2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('could not lease a device: token missing'),
    });
  });

  it('reports a release failure once every lease was tried, and a slot outside the leases as an engine defect', async () => {
    const cloud = provider({ failRelease: true });
    const h = harness({ device: cloud.impl });
    await h.prepare(prepareInfo({}, 2));
    await expect(h.engine.finish!(finishInfo())).rejects.toMatchObject({
      message: expect.stringContaining('could not release a device: stop failed'),
    });
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);

    const again = harness({ device: cloud.impl });
    await again.prepare(prepareInfo({}, 1));
    await expect(boot(again, 'ios', 1)).rejects.toMatchObject({
      message: expect.stringContaining('worker slot 1 is outside a device pool of 1'),
    });
  });

  it('without a prepared lease a provider-backed worker falls back to the local daemon, and finish has nothing to release', async () => {
    const cloud = provider();
    const h = harness({ device: cloud.impl });
    await boot(h, 'ios', 0);
    expect(h.connections).toEqual([undefined]);
    expect(h.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios' });
    await h.engine.finish!(finishInfo());
    expect(cloud.released).toEqual([]);
  });
});

describe('device provider recording', () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-device-provider-'));
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  const operation = (signal = new AbortController().signal): OperationContext => ({ signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1', origin: 'test' });
  const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 5_000 });
  const records = (h: Harness) => h.fake.methods().filter((method) => method === 'recording.record');

  /**
   * A scripted provider whose service records: `start` answers `record`, and
   * each `stop` of a started recording answers what `stop` resolves to.
   */
  function recordingProvider(options: {
    start?: (lease: DeviceLease, context: ProviderRecordContext) => Promise<void>;
    stop?: (context: ProviderRecordingStopContext) => Promise<ProviderRecordingResult>;
  } = {}) {
    const recorded: { lease: DeviceLease; context: ProviderRecordContext }[] = [];
    const stopped: ProviderRecordingStopContext[] = [];
    const impl: DeviceProvider = {
      name: 'toy-cloud',
      async acquire(request) {
        const lease = { id: `lease-${request.slot}`, daemon: { baseUrl: `https://${request.slot}.example` }, device: `sim-${request.slot}`, session: 'kept by the provider' };
        return lease;
      },
      async release() {},
      async record(lease, context): Promise<ProviderRecording> {
        recorded.push({ lease, context });
        await options.start?.(lease, context);
        return {
          startedAt: '2026-09-28T10:00:00.000Z',
          async stop(stopContext) {
            stopped.push(stopContext);
            if (options.stop !== undefined) return options.stop(stopContext);
            writeFileSync(path.join(stopContext.dir, 'replay.mp4'), 'mp4 bytes');
            return { file: 'replay.mp4' };
          },
        };
      },
    };
    return { impl, recorded, stopped };
  }

  /** Prepares one leased slot in the runner, then boots a child worker on it from the environment `prepare` returned. */
  async function leasedWorker(impl: DeviceProvider): Promise<Harness> {
    const runner = harness({ device: impl });
    const result = await runner.prepare(prepareInfo({ DEVICE_SERVICE_TOKEN: 't' }, 1));
    const worker = harness({ device: impl });
    await boot(worker, 'ios', 0, { ...result?.env, DEVICE_SERVICE_TOKEN: 't' });
    await worker.engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    return worker;
  }

  it('refuses a provider whose record is not a function', () => {
    const odd = { name: 'x', acquire: async () => ({}), release: async () => undefined, record: 'yes' } as unknown as DeviceProvider;
    expect(() => harness({ device: odd })).toThrow(/mobile: device provider "x" has a record that is not a function/);
  });

  it('records through the provider instead of agent-device, from the worker, with the lease id and the declared lease fields', async () => {
    const cloud = recordingProvider();
    const worker = await leasedWorker(cloud.impl);
    await worker.engine.artifacts!.startVideo!(operation());
    // The lease as it traveled to the worker: the id rode the binding, the provider's own field stayed behind.
    expect(cloud.recorded).toHaveLength(1);
    expect(cloud.recorded[0]!.lease).toEqual({ id: 'lease-0', device: 'sim-0', daemon: { baseUrl: 'https://0.example' } });
    const { signal, ...context } = cloud.recorded[0]!.context;
    expect(context).toEqual({ runId: 'run-1', targetName: 'ios', attemptId: 'a1', env: expect.objectContaining({ DEVICE_SERVICE_TOKEN: 't' }) });
    expect(signal).toBeInstanceOf(AbortSignal);
    const segments = await worker.engine.artifacts!.stopVideo!(operation());
    expect(segments).toEqual([{ path: path.posix.join('video', 'replay.mp4'), startedAt: '2026-09-28T10:00:00.000Z' }]);
    expect(cloud.stopped.map((stop) => stop.dir)).toEqual([path.join(artifactsDir, 'video')]);
    expect(existsSync(path.join(artifactsDir, 'video', 'replay.mp4'))).toBe(true);
    await worker.engine.endAttempt!(cleanup());
    // agent-device recorded nothing, and nothing is left for endAttempt to stop.
    expect(records(worker)).toEqual([]);
    expect(cloud.stopped).toHaveLength(1);
  });

  it('reports a recording the service keeps as a link', async () => {
    const cloud = recordingProvider({ stop: async () => ({ url: 'https://toy.example/replays/lease-0.mp4', mediaType: 'video/mp4' }) });
    const worker = await leasedWorker(cloud.impl);
    await worker.engine.artifacts!.startVideo!(operation());
    expect(await worker.engine.artifacts!.stopVideo!(operation())).toEqual([
      { url: 'https://toy.example/replays/lease-0.mp4', mediaType: 'video/mp4', startedAt: '2026-09-28T10:00:00.000Z' },
    ]);
  });

  it('keeps the agent-device recording for a provider without record', async () => {
    const worker = await leasedWorker(provider().impl);
    await worker.engine.artifacts!.startVideo!(operation());
    expect(worker.fake.lastArgs('recording.record')).toEqual({ platform: 'ios', device: 'sim-0', action: 'start', path: path.join(artifactsDir, 'video', 'video.mp4'), quality: 'medium', recordingScope: 'device' });
    await worker.engine.artifacts!.stopVideo!(operation());
    expect(records(worker)).toHaveLength(2);
  });

  it('keeps the agent-device recording for a worker without a lease, when no prepare ran', async () => {
    const cloud = recordingProvider();
    const worker = harness({ device: cloud.impl });
    await boot(worker, 'ios', 0);
    await worker.engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await worker.engine.artifacts!.startVideo!(operation());
    expect(cloud.recorded).toEqual([]);
    expect(records(worker)).toHaveLength(1);
  });

  it('names the provider and the lease when record fails, and has nothing to stop at attempt end', async () => {
    const cloud = recordingProvider({
      start: async () => {
        throw new Error('recording quota exceeded');
      },
    });
    const worker = await leasedWorker(cloud.impl);
    await expect(worker.engine.artifacts!.startVideo!(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: 'device provider "toy-cloud" could not start recording: recording quota exceeded for lease lease-0',
    });
    await worker.engine.endAttempt!(cleanup());
    expect(cloud.stopped).toEqual([]);
    expect(records(worker)).toEqual([]);
  });

  it('cancels a start whose budget ran out, and stops the recording that came up anyway at attempt end', async () => {
    let arrive: (() => void) | undefined;
    const cloud = recordingProvider({ start: () => new Promise<void>((resolve) => (arrive = resolve)) });
    const worker = await leasedWorker(cloud.impl);
    const budget = new AbortController();
    const starting = worker.engine.artifacts!.startVideo!(operation(budget.signal));
    budget.abort();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    arrive!();
    await worker.engine.endAttempt!(cleanup());
    expect(cloud.stopped).toHaveLength(1);
  });

  it('never asks the provider to record for an operation already cancelled', async () => {
    const cloud = recordingProvider();
    const worker = await leasedWorker(cloud.impl);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(worker.engine.artifacts!.startVideo!(operation(cancelled.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cloud.recorded).toEqual([]);
  });

  it('stops a provider recording when the worker is disposed mid-attempt', async () => {
    const cloud = recordingProvider();
    const worker = await leasedWorker(cloud.impl);
    await worker.engine.artifacts!.startVideo!(operation());
    await worker.engine.dispose!(cleanup());
    expect(cloud.stopped).toHaveLength(1);
  });

  it('keeps a recording whose stop failed, so endAttempt stops it once more', async () => {
    let failures = 1;
    const cloud = recordingProvider({
      stop: async (context) => {
        if (failures-- > 0) throw new Error('replay not ready');
        writeFileSync(path.join(context.dir, 'replay.mp4'), 'mp4 bytes');
        return { file: 'replay.mp4' };
      },
    });
    const worker = await leasedWorker(cloud.impl);
    await worker.engine.artifacts!.startVideo!(operation());
    await expect(worker.engine.artifacts!.stopVideo!(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: 'device provider "toy-cloud" recording lease lease-0 could not finish: replay not ready',
    });
    expect(cloud.stopped).toHaveLength(1);
    await worker.engine.endAttempt!(cleanup());
    expect(cloud.stopped).toHaveLength(2);
    // Stopped for good: the next attempt starts with nothing recording.
    await worker.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await worker.engine.endAttempt!(cleanup());
    expect(cloud.stopped).toHaveLength(2);
  });
});
