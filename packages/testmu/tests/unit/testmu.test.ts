/**
 * `testmu()` against a stubbed agent-device client: the options it refuses,
 * the lease it allocates and hands the worker, the credentials it reads and
 * shares with the daemon, the heartbeat that keeps it alive, and the release
 * on every exit path. `recording.test.ts` covers `record`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmu, type TestmuOptions } from '../../src/index.ts';

interface ClientCall {
  readonly config: Record<string, unknown>;
  readonly operation: 'allocate' | 'heartbeat' | 'release';
  readonly options: Record<string, unknown>;
}

const daemon = {
  calls: [] as ClientCall[],
  /** Runs inside `allocate`, before it answers. */
  onAllocate: undefined as (() => void) | undefined,
  /** What an `allocate` from a client of that session waits for, once, before it runs `onAllocate`. */
  allocateGates: {} as Record<string, Promise<void>>,
  /** Runs inside `heartbeat` and `release`, before they answer. */
  onHeartbeat: undefined as (() => void) | undefined,
  onRelease: undefined as (() => void) | undefined,
  allocateError: undefined as Error | undefined,
  /** Errors `release` answers with, in order, before it succeeds. */
  releaseErrors: [] as Error[],
  /** Errors `heartbeat` answers with, in order, before it succeeds. */
  heartbeatErrors: [] as Error[],
};

vi.mock('agent-device', () => ({
  createAgentDeviceClient: (config: Record<string, unknown>) => ({
    leases: {
      allocate: async (options: Record<string, unknown>) => {
        daemon.calls.push({ config, operation: 'allocate', options });
        const gate = daemon.allocateGates[String(config['session'])];
        delete daemon.allocateGates[String(config['session'])];
        if (gate !== undefined) await gate;
        daemon.onAllocate?.();
        if (daemon.allocateError !== undefined) throw daemon.allocateError;
        return { leaseId: `lease-${daemon.calls.length}`, tenantId: options['tenant'], runId: options['runId'], backend: options['leaseBackend'], leaseProvider: options['leaseProvider'] };
      },
      heartbeat: async (options: Record<string, unknown>) => {
        daemon.calls.push({ config, operation: 'heartbeat', options });
        daemon.onHeartbeat?.();
        const error = daemon.heartbeatErrors.shift();
        if (error !== undefined) throw error;
        return { leaseId: options['leaseId'], tenantId: options['tenant'], runId: options['runId'], backend: options['leaseBackend'] };
      },
      release: async (options: Record<string, unknown>) => {
        daemon.calls.push({ config, operation: 'release', options });
        daemon.onRelease?.();
        const error = daemon.releaseErrors.shift();
        if (error !== undefined) throw error;
        return { released: true };
      },
    },
  }),
}));

/** A real directory: the provider writes each run's marker under the project root. */
const ROOT = mkdtempSync(join(tmpdir(), 'testmu-unit-'));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
const env = { LT_USERNAME: 'ada', LT_ACCESS_KEY: 'lt-key' };
const options: TestmuOptions = { device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'https://example.com/app.apk' };
const saved = { LT_USERNAME: process.env['LT_USERNAME'], LT_ACCESS_KEY: process.env['LT_ACCESS_KEY'] };

beforeEach(() => {
  Object.assign(daemon, {
    calls: [],
    onAllocate: undefined,
    allocateGates: {},
    onHeartbeat: undefined,
    onRelease: undefined,
    allocateError: undefined,
    releaseErrors: [],
    heartbeatErrors: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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
    agentDeviceVersion: '0.21.18',
    projectRoot: ROOT,
    env,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

const context: DeviceReleaseContext = { runId: 'run-1', targetName: 'android', env, signal: new AbortController().signal, log: () => undefined };

const operations = () => daemon.calls.map((call) => call.operation);

const runnerCredentials = () => [process.env['LT_USERNAME'], process.env['LT_ACCESS_KEY']];

const MINUTE = 60_000;

describe('testmu()', () => {
  it("is a device provider named testmu that records through TestMu AI's own session video", () => {
    const provider = testmu(options);
    expect(provider.name).toBe('testmu');
    expect(provider.record).toBeTypeOf('function');
  });

  it('allocates an Android lease from a daemon under the project root, with the device selectors and dashboard labels', async () => {
    await testmu(options).acquire(request({ slot: 1 }));
    expect(daemon.calls).toEqual([
      {
        config: { stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'), session: 'lease-1' },
        operation: 'allocate',
        options: {
          tenant: 'testmu',
          runId: 'run-1',
          leaseBackend: 'android-instance',
          leaseProvider: 'testmu',
          platform: 'android',
          target: 'mobile',
          device: 'Galaxy S22 Ultra 5G',
          providerOsVersion: '14',
          providerApp: 'https://example.com/app.apk',
          providerDeviceType: 'virtual',
          providerProject: 'e2e',
          providerBuild: 'run-1',
          providerSessionName: 'e2e-run-1-android-2',
          ttlMs: 10 * MINUTE,
        },
      },
    ]);
  });

  it('allocates an iOS lease on a real device with its own project, build, session name, and state directory', async () => {
    await testmu({ device: 'iPhone 16', osVersion: '18', app: 'lt://APP123', deviceType: 'real', project: 'shop', build: 'nightly', sessionName: 'checkout', stateDir: 'tmp/devices' }).acquire(
      request({ platform: 'ios' }),
    );
    expect(daemon.calls[0]?.config['stateDir']).toBe(join(ROOT, 'tmp', 'devices', 'run-1'));
    expect(daemon.calls[0]?.options).toMatchObject({
      leaseBackend: 'ios-instance',
      platform: 'ios',
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
    expect(daemon.calls.map((call) => call.options['providerSessionName'])).toEqual(['e2e-run-7-pixel-1', 'e2e-run-7-pixel-3', 'checkout-3', 'checkout']);
  });

  it('passes the device features to the allocation and the worker under agent-device\'s keys', async () => {
    const lease = await testmu({ ...options, orientation: 'landscape', geoLocation: 'US', timezone: 'UTC+05:30', language: 'fr', locale: 'fr_FR', appiumVersion: '2.16.2' }).acquire(request());
    const features = {
      providerDeviceOrientation: 'landscape',
      providerGeoLocation: 'US',
      providerTimezone: 'UTC+05:30',
      providerLanguage: 'fr',
      providerLocale: 'fr_FR',
      providerAppiumVersion: '2.16.2',
    };
    expect(daemon.calls[0]?.options).toMatchObject(features);
    expect(lease.client).toMatchObject(features);
  });

  it('resolves a local build against the project root, never the working directory', async () => {
    await testmu({ ...options, app: 'build/app.apk' }).acquire(request());
    expect(daemon.calls[0]?.options['providerApp']).toBe(join(ROOT, 'build', 'app.apk'));
    await testmu({ ...options, app: join('/', 'builds', 'app.apk') }).acquire(request());
    expect(daemon.calls[1]?.options['providerApp']).toBe(join('/', 'builds', 'app.apk'));
  });

  it('hands the worker the lease scope and the selectors as JSON client configuration', async () => {
    const req = request();
    const lease = await testmu(options).acquire(req);
    expect(lease).toEqual({
      id: 'lease-1',
      client: {
        stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'),
        tenant: 'testmu',
        runId: 'run-1',
        leaseId: 'lease-1',
        leaseBackend: 'android-instance',
        leaseProvider: 'testmu',
        platform: 'android',
        target: 'mobile',
        device: 'Galaxy S22 Ultra 5G',
        providerOsVersion: '14',
        providerApp: 'https://example.com/app.apk',
        providerDeviceType: 'virtual',
        providerProject: 'e2e',
        providerBuild: 'run-1',
        providerSessionName: 'e2e-run-1-android-1',
      },
    });
    const json = JSON.stringify(lease);
    expect(JSON.parse(json)).toEqual(lease);
    expect(Buffer.byteLength(json)).toBeLessThan(1024);
    expect(json).not.toContain('lt-key');
    expect(req.lines).toEqual(['lease lease-1: Galaxy S22 Ultra 5G, android 14 (virtual); session e2e-run-1-android-1 started']);
  });

  it("shares the run's credentials with a daemon the allocation starts, and puts back the process's own after it", async () => {
    delete process.env['LT_USERNAME'];
    process.env['LT_ACCESS_KEY'] = 'stale';
    daemon.onAllocate = () => expect(runnerCredentials()).toEqual(['ada', 'lt-key']);
    await testmu(options).acquire(request({ env: { LT_USERNAME: ' ada ', LT_ACCESS_KEY: 'lt-key' } }));
    expect(operations()).toEqual(['allocate']);
    expect(runnerCredentials()).toEqual([undefined, 'stale']);
  });

  it('keeps the credentials in place until every allocation running at once has finished', async () => {
    delete process.env['LT_USERNAME'];
    delete process.env['LT_ACCESS_KEY'];
    let open!: () => void;
    daemon.allocateGates = { 'lease-1': new Promise<void>((resolve) => (open = resolve)) };
    const seen: unknown[] = [];
    daemon.onAllocate = () => seen.push(runnerCredentials());
    const provider = testmu(options);
    const first = provider.acquire(request({ slot: 0 }));
    const second = provider.acquire(request({ slot: 1 }));
    await vi.waitFor(() => expect(operations()).toEqual(['allocate', 'allocate']));
    await first;
    expect(runnerCredentials()).toEqual(['ada', 'lt-key']);
    open();
    await second;
    expect(seen).toEqual([
      ['ada', 'lt-key'],
      ['ada', 'lt-key'],
    ]);
    expect(runnerCredentials()).toEqual([undefined, undefined]);
  });

  it('makes a daemon call with other credentials wait until the calls with the first have finished', async () => {
    delete process.env['LT_USERNAME'];
    delete process.env['LT_ACCESS_KEY'];
    let open!: () => void;
    daemon.allocateGates = { 'lease-0': new Promise<void>((resolve) => (open = resolve)) };
    const seen: unknown[] = [];
    daemon.onAllocate = () => seen.push(runnerCredentials());
    const alice = testmu(options).acquire(request({ env: { LT_USERNAME: 'alice', LT_ACCESS_KEY: 'alice-key' } }));
    await vi.waitFor(() => expect(operations()).toEqual(['allocate']));
    const bob = testmu(options).acquire(request({ slot: 1, env: { LT_USERNAME: 'bob', LT_ACCESS_KEY: 'bob-key' } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(operations()).toEqual(['allocate']);
    expect(runnerCredentials()).toEqual(['alice', 'alice-key']);
    open();
    await Promise.all([alice, bob]);
    expect(seen).toEqual([
      ['alice', 'alice-key'],
      ['bob', 'bob-key'],
    ]);
    expect(runnerCredentials()).toEqual([undefined, undefined]);
  });

  it('leaves a value the host changed during a daemon call', async () => {
    process.env['LT_USERNAME'] = 'host';
    process.env['LT_ACCESS_KEY'] = 'host-key';
    daemon.onAllocate = () => {
      process.env['LT_USERNAME'] = 'changed-by-host';
    };
    await testmu(options).acquire(request());
    expect(runnerCredentials()).toEqual(['changed-by-host', 'host-key']);
  });

  it('shares the credentials with a daemon a heartbeat or a release starts', async () => {
    vi.useFakeTimers();
    process.env['LT_USERNAME'] = 'host';
    delete process.env['LT_ACCESS_KEY'];
    const seen: unknown[] = [];
    daemon.onHeartbeat = () => seen.push(['heartbeat', ...runnerCredentials()]);
    daemon.onRelease = () => seen.push(['release', ...runnerCredentials()]);
    const provider = testmu(options);
    const lease = await provider.acquire(request());
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(runnerCredentials()).toEqual(['host', undefined]);
    await provider.release(lease, { ...context, env: { LT_USERNAME: 'grace', LT_ACCESS_KEY: 'other-key' } });
    expect(seen).toEqual([
      ['heartbeat', 'ada', 'lt-key'],
      ['release', 'grace', 'other-key'],
    ]);
    expect(runnerCredentials()).toEqual(['host', undefined]);
  });

  it('releases a lease without credentials in the release environment, through the daemon already running', async () => {
    const provider = testmu(options);
    const lease = await provider.acquire(request());
    await provider.release(lease, { ...context, env: {} });
    expect(operations()).toEqual(['allocate', 'release']);
  });

  it.each([
    [{}, 'LT_USERNAME and LT_ACCESS_KEY are not set'],
    [{ LT_USERNAME: 'ada' }, 'LT_ACCESS_KEY is not set'],
    [{ LT_USERNAME: '  ', LT_ACCESS_KEY: 'lt-key' }, 'LT_USERNAME is not set'],
  ])('fails before any daemon starts without credentials in the run\'s environment (%j)', async (runEnv, message) => {
    process.env['LT_USERNAME'] = 'from-the-runner';
    process.env['LT_ACCESS_KEY'] = 'from-the-runner';
    await expect(testmu(options).acquire(request({ env: runEnv }))).rejects.toThrow(
      `${message}; set LT_USERNAME and LT_ACCESS_KEY to your TestMu AI username and access key in the environment \`e2e run\` starts in`,
    );
    expect(daemon.calls).toEqual([]);
  });

  it("refuses the target's app.appPath, since TestMu AI installs `app`", async () => {
    await expect(testmu(options).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }))).rejects.toThrow(
      "TestMu AI installs the app from `app`; leave the target's `app.appPath` out",
    );
    expect(daemon.calls).toEqual([]);
  });

  it('allocates nothing once the run is interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(testmu(options).acquire(request({ signal: controller.signal }))).rejects.toThrow('cancelled before a lease was allocated');
    expect(daemon.calls).toEqual([]);
  });

  it('releases a lease granted after an interrupt instead of handing it over', async () => {
    const controller = new AbortController();
    daemon.onAllocate = () => controller.abort();
    const req = request({ signal: controller.signal });
    await expect(testmu(options).acquire(req)).rejects.toThrow('lease lease-1 was not handed to the run: cancelled; released it');
    expect(daemon.calls[1]).toEqual({
      config: { stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'), session: 'release' },
      operation: 'release',
      options: { tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'testmu' },
    });
    expect(req.lines).toEqual([]);
  });

  it('releases a granted lease when handing it over fails, and says when that release failed too', async () => {
    daemon.releaseErrors = [new Error('daemon gone')];
    const req = request({
      log: () => {
        throw new Error('reporter closed');
      },
    });
    await expect(testmu(options).acquire(req)).rejects.toThrow('lease lease-1 was not handed to the run: reporter closed; releasing it failed (daemon gone)');
    expect(operations()).toEqual(['allocate', 'release']);
  });

  it('passes an allocation failure through with nothing to release', async () => {
    daemon.allocateError = new Error('unknown lease provider testmu');
    await expect(testmu(options).acquire(request())).rejects.toThrow('unknown lease provider testmu');
    expect(operations()).toEqual(['allocate']);
  });

  it('releases a lease through the daemon that granted it, once however often it is asked', async () => {
    const provider = testmu(options);
    const lease = await provider.acquire(request());
    await Promise.all([provider.release(lease, context), provider.release(lease, context)]);
    await provider.release(lease, context);
    expect(daemon.calls.slice(1)).toEqual([
      {
        config: { stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'), session: 'release' },
        operation: 'release',
        options: { tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'testmu' },
      },
    ]);
  });

  it('releases from the lease alone, after a round trip through JSON', async () => {
    const lease = JSON.parse(JSON.stringify(await testmu(options).acquire(request({ platform: 'ios' })))) as DeviceLease;
    await testmu(options).release(lease, context);
    expect(daemon.calls[1]?.options).toEqual({ tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'ios-instance', leaseProvider: 'testmu' });
  });

  it('tries a release again after one failed', async () => {
    daemon.releaseErrors = [new Error('daemon busy')];
    const provider = testmu(options);
    const lease = await provider.acquire(request());
    await expect(provider.release(lease, context)).rejects.toThrow('daemon busy');
    await provider.release(lease, context);
    expect(operations()).toEqual(['allocate', 'release', 'release']);
  });

  it('refuses to release a lease without an agent-device scope', async () => {
    await expect(testmu(options).release({ id: 'other', client: { stateDir: '/tmp/x' } }, context)).rejects.toThrow('lease other carries no agent-device lease scope to release');
    expect(daemon.calls).toEqual([]);
  });

  it('heartbeats each lease it holds every two minutes, asking for the longest lease, until it is released', async () => {
    vi.useFakeTimers();
    const provider = testmu(options);
    const lease = await provider.acquire(request());
    await vi.advanceTimersByTimeAsync(2 * MINUTE - 1);
    expect(operations()).toEqual(['allocate']);
    await vi.advanceTimersByTimeAsync(1);
    expect(daemon.calls[1]).toEqual({
      config: { stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'), session: 'heartbeat' },
      operation: 'heartbeat',
      options: { tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'testmu', ttlMs: 10 * MINUTE },
    });
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(operations()).toEqual(['allocate', 'heartbeat', 'heartbeat']);
    await provider.release(lease, context);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(operations()).toEqual(['allocate', 'heartbeat', 'heartbeat', 'release']);
  });

  it('stops heartbeating a lease it released because handing it over failed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    daemon.onAllocate = () => controller.abort();
    await expect(testmu(options).acquire(request({ signal: controller.signal }))).rejects.toThrow('was not handed to the run');
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(operations()).toEqual(['allocate', 'release']);
  });

  it('heartbeats nothing when the allocation failed', async () => {
    vi.useFakeTimers();
    daemon.allocateError = new Error('no capacity');
    await expect(testmu(options).acquire(request())).rejects.toThrow('no capacity');
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(operations()).toEqual(['allocate']);
  });

  it('logs the first failed heartbeat and keeps beating, without failing the run', async () => {
    vi.useFakeTimers();
    daemon.heartbeatErrors = [new Error('Lease is not active'), new Error('daemon gone')];
    const req = request();
    await testmu(options).acquire(req);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(operations()).toEqual(['allocate', 'heartbeat', 'heartbeat', 'heartbeat']);
    expect(req.lines.slice(1)).toEqual(['lease lease-1: heartbeat failed (Lease is not active); agent-device ends the lease after 10 minutes without one']);
  });

  it('survives a failed heartbeat when the run\'s log is closed', async () => {
    vi.useFakeTimers();
    daemon.heartbeatErrors = [new Error('daemon gone')];
    let closed = false;
    await testmu(options).acquire(
      request({
        log: () => {
          if (closed) throw new Error('reporter closed');
        },
      }),
    );
    closed = true;
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(operations()).toEqual(['allocate', 'heartbeat', 'heartbeat']);
  });

  it('rejects an option it does not take with INVALID_CONFIG, naming the nearest one', () => {
    expect(() => testmu({ ...options, osVerison: '14' } as unknown as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('osVersion') }));
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

  it.each(['project', 'build', 'sessionName', 'stateDir'] as const)('refuses an empty or non-string `%s` with INVALID_CONFIG', (key) => {
    for (const value of [' ', 1, null]) {
      expect(() => testmu({ ...options, [key]: value } as unknown as TestmuOptions)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: `testmu: \`${key}\` must be a non-empty string` }),
      );
    }
  });
});
