/**
 * The browser provider seam without a real browser: a scripted provider and a
 * mocked CDP attach. Leases per slot and the hand-off to workers, the endpoint
 * each worker attaches to, replacement after a dropped browser, per-attempt
 * leases, and release on every path.
 */

import type { Browser } from 'playwright';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAttemptContext, EngineCleanupContext, EngineFinishInfo, EngineInitInfo, EnginePrepareInfo, OperationContext } from 'e2e/engine';
import { connectCdp } from '../../src/browser-connection.ts';
import { web } from '../../src/index.ts';
import type { BrowserLease, BrowserProvider, BrowserRequest } from '../../src/provider.ts';
import { PlaywrightSurface } from '../../src/surface.ts';

vi.mock('../../src/browser-connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-connection.ts')>()),
  connectCdp: vi.fn(),
}));

/** A browser the mocked attach hands back: enough of one for a context per attempt or a persistent default context. */
function fakeBrowser(contextId: string) {
  let connected = true;
  const context = {
    addInitScript: async () => undefined,
    setDefaultTimeout: () => undefined,
    on: () => undefined,
    route: async () => undefined,
    close: async () => undefined,
    pages: () => [],
    tracing: { start: async () => undefined, stop: async () => undefined },
    _channel: { registerSelectorEngine: async () => undefined },
  };
  const browser = {
    isConnected: () => connected,
    newContext: async () => context,
    newBrowserCDPSession: async () => ({
      send: async () => ({ browserContextIds: [], defaultBrowserContextId: contextId }),
      detach: async () => undefined,
    }),
    contexts: () => [context],
    close: async () => { connected = false; },
  } as unknown as Browser;
  return { browser, drop: () => { connected = false; } };
}

/** A scripted provider: leases `lease-<n>` against `wss://<n>.example`, remembering every call. */
function provider(options: { scope?: 'worker' | 'attempt'; failSlot?: number; failRelease?: boolean; reconnect?: boolean } = {}) {
  const acquired: BrowserRequest[] = [];
  const released: BrowserLease[] = [];
  let sequence = 0;
  const impl: BrowserProvider = {
    name: 'toy-cloud',
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    async acquire(request) {
      acquired.push(request);
      if (request.slot === options.failSlot) throw new Error(`no capacity for slot ${request.slot}`);
      request.log('starting');
      const n = sequence++;
      return {
        id: `lease-${n}`,
        cdpEndpoint: `wss://${n}.example`,
        ...(options.reconnect === true ? { reconnectEndpoint: `wss://${n}.example/reconnect` } : {}),
        // A provider's own bookkeeping never reaches a worker.
        secret: 'x'.repeat(100),
      } as BrowserLease;
    },
    async release(lease) {
      released.push(lease);
      if (options.failRelease === true) throw new Error('stop failed');
    },
  };
  return { impl, acquired, released };
}

const prepareInfo = (slots: number, log: (line: string) => void = () => undefined, env: Record<string, string> = { BROWSER_TOKEN: 't' }): EnginePrepareInfo => ({
  runId: 'run-1',
  targetName: 'web',
  projectRoot: '/project',
  slots,
  env,
  signal: new AbortController().signal,
  log,
});
const finishInfo = (log: (line: string) => void = () => undefined): EngineFinishInfo => ({
  runId: 'run-1',
  targetName: 'web',
  env: { BROWSER_TOKEN: 't' },
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  log,
});
const initInfo = (workerSlot: number, env: Readonly<Record<string, string | undefined>> = {}): EngineInitInfo => ({
  runId: 'run-1',
  targetName: 'web',
  projectRoot: '/project',
  app: {},
  env,
  headed: false,
  workerSlot,
  signal: new AbortController().signal,
  log: () => undefined,
});
const attempt = (attemptId: string): EngineAttemptContext => ({ attemptId, artifactsDir: '/tmp/e2e-provider-artifacts', signal: new AbortController().signal });
const cleanup = (): EngineCleanupContext => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run-1', attemptId: 'a1', origin: 'test' });

/** The variable `prepare` wrote for the `web` target, found by its readable prefix (the suffix is a digest of the name). */
function leasesVariableIn(env: Readonly<Record<string, string | undefined>>): string {
  const key = Object.keys(env).find((candidate) => /^E2E_WEB_BROWSERS_WEB_[0-9A-F]{8}$/.test(candidate));
  if (key === undefined) throw new Error(`no leases variable in ${Object.keys(env).join(', ')}`);
  return key;
}

/** Runs `prepare` and returns the environment it left for the workers. */
async function prepared(cloud: BrowserProvider, slots: number): Promise<{ runner: PlaywrightSurface; env: Record<string, string> }> {
  const runner = new PlaywrightSurface({ browser: cloud });
  const result = await runner.prepare(prepareInfo(slots));
  return { runner, env: (result?.env ?? {}) as Record<string, string> };
}

beforeEach(() => {
  vi.mocked(connectCdp).mockReset();
  vi.mocked(connectCdp).mockImplementation(async (endpoint) => fakeBrowser(`context-${endpoint}`).browser);
});

describe('web({ browser: provider })', () => {
  it('rejects a provider without a name, the two methods, or a known scope', () => {
    expect(() => web({ browser: { name: '' } as unknown as BrowserProvider })).toThrow(/non-empty `name`/);
    expect(() => web({ browser: { name: 'x', acquire: async () => ({}) } as unknown as BrowserProvider })).toThrow(
      /provider "x" must implement release\(\)/,
    );
    expect(() => web({ browser: { ...provider().impl, scope: 'run' } as unknown as BrowserProvider })).toThrow(
      /has scope "run"; use "worker" or "attempt"/,
    );
    expect(() => web({ browser: provider({ scope: 'attempt' }).impl })).not.toThrow();
  });

  it('rejects a provider together with connect: two browser sources', () => {
    expect(() => web({ browser: provider().impl, connect: { cdpEndpoint: () => 'ws://x' } })).toThrow(/two browser sources/);
  });

  it('rejects creation-time headers and credentials with an attempt-scoped provider, as persistent connect does', () => {
    const cloud = provider({ scope: 'attempt' }).impl;
    expect(() => web({ browser: cloud, headers: { 'x-preview': 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ browser: cloud, basicAuth: { username: 'user', password: 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ browser: provider().impl, headers: { 'x-preview': 'synthetic' } })).not.toThrow();
  });

  it('declares context replacement for worker scope and not for attempt scope, and a finish hook for both', () => {
    const perWorker = web({ browser: provider().impl });
    expect(perWorker.state).toBeDefined();
    expect(perWorker.session?.reset).toBeTypeOf('function');
    expect(perWorker.finish).toBeTypeOf('function');
    const perAttempt = web({ browser: provider({ scope: 'attempt' }).impl });
    expect(perAttempt.state).toBeUndefined();
    expect(perAttempt.session?.reset).toBeUndefined();
    expect(perAttempt.session?.restart).toBeTypeOf('function');
  });
});

describe('worker scope', () => {
  it('leases one browser per slot at prepare, hands the declared fields to the workers, and each worker attaches to its own', async () => {
    const cloud = provider();
    const runner = new PlaywrightSurface({ browser: cloud.impl });
    const lines: string[] = [];
    const result = await runner.prepare(prepareInfo(2, (line) => lines.push(line)));
    expect(result?.workers).toBe(2);
    expect(cloud.acquired.map((request) => [request.slot, request.slots, request.attemptId, request.runId, request.targetName])).toEqual([
      [0, 2, undefined, 'run-1', 'web'],
      [1, 2, undefined, 'run-1', 'web'],
    ]);
    expect(cloud.acquired[0]!.env).toEqual({ BROWSER_TOKEN: 't' });
    expect(lines).toEqual([
      'leasing 2 browser(s) from toy-cloud',
      'toy-cloud (1 of 2): starting',
      'toy-cloud (2 of 2): starting',
      'toy-cloud: leased lease-0',
      'toy-cloud: leased lease-1',
    ]);
    const env = result?.env ?? {};
    const variable = leasesVariableIn(env);
    expect(JSON.parse(env[variable]!)).toEqual({
      slots: 2,
      leases: [
        { id: 'lease-0', cdpEndpoint: 'wss://0.example' },
        { id: 'lease-1', cdpEndpoint: 'wss://1.example' },
      ],
    });
    // Nothing was attached in the runner: leasing is not connecting.
    expect(connectCdp).not.toHaveBeenCalled();

    // A worker reads its slot's lease from the environment and attaches to that endpoint.
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(1, { [variable]: env[variable] }));
    expect(vi.mocked(connectCdp).mock.calls.map(([endpoint]) => endpoint)).toEqual(['wss://1.example']);
    await worker.startAttempt(attempt('a1'));
    await worker.endAttempt(cleanup());
    await worker.dispose(cleanup());
    // The worker acquired nothing of its own, so it released nothing.
    expect(cloud.acquired).toHaveLength(2);
    expect(cloud.released).toEqual([]);

    // The runner releases what it leased, handing back the provider's own objects.
    const finished: string[] = [];
    await runner.finish(finishInfo((line) => finished.push(line)));
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
    expect(cloud.released[0]).toHaveProperty('secret');
    expect(finished).toEqual(['toy-cloud: released 2 browser(s)']);
    await runner.finish(finishInfo());
    expect(cloud.released).toHaveLength(2);
  });

  it('leases nothing for a target with no slots', async () => {
    const cloud = provider();
    const runner = new PlaywrightSurface({ browser: cloud.impl });
    expect(await runner.prepare(prepareInfo(0))).toEqual({});
    expect(cloud.acquired).toEqual([]);
    await runner.finish(finishInfo());
    expect(cloud.released).toEqual([]);
  });

  it('holds the slots that leased when another fails, so finish releases them, and fails the run before any test', async () => {
    const cloud = provider({ failSlot: 1 });
    const runner = new PlaywrightSurface({ browser: cloud.impl });
    await expect(runner.prepare(prepareInfo(2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not lease a browser: no capacity for slot 1'),
    });
    await runner.finish(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });

  it('treats an acquire that throws before its first await like any other failed slot', async () => {
    const sync: BrowserProvider = {
      name: 'sync',
      acquire(request) {
        if (request.slot === 1) throw new Error('token missing');
        return Promise.resolve({ id: `l-${request.slot}`, cdpEndpoint: 'wss://d.example' });
      },
      async release() {},
    };
    const runner = new PlaywrightSurface({ browser: sync });
    await expect(runner.prepare(prepareInfo(2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('token missing'),
    });
  });

  it('reports a release failure once every lease was tried', async () => {
    const cloud = provider({ failRelease: true });
    const runner = new PlaywrightSurface({ browser: cloud.impl });
    await runner.prepare(prepareInfo(2));
    await expect(runner.finish(finishInfo())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not release a browser: stop failed'),
    });
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
  });

  it('rejects leases too large for a worker environment, by bytes', async () => {
    const oversized: BrowserProvider = {
      name: 'huge',
      async acquire(request) {
        // Multi-byte characters: the cap is on bytes, not string length.
        return { id: `l-${request.slot}`, cdpEndpoint: `wss://d.example/${'ż'.repeat(9_000)}` };
      },
      async release() {},
    };
    const runner = new PlaywrightSurface({ browser: oversized });
    await expect(runner.prepare(prepareInfo(1))).rejects.toMatchObject({
      message: expect.stringContaining('the worker environment carries at most 16384'),
    });
  });

  it('refuses a lease without an id and a cdpEndpoint, or with a reconnectEndpoint that is not one, and still releases nothing for it', async () => {
    for (const lease of [{}, { id: 'bare' }, { cdpEndpoint: 'wss://d.example' }, { id: ' ', cdpEndpoint: 'wss://d.example' }, { id: 'x', cdpEndpoint: 'wss://d.example', reconnectEndpoint: 7 }]) {
      const released: BrowserLease[] = [];
      const odd: BrowserProvider = { name: 'odd', acquire: async () => lease as unknown as BrowserLease, release: async (granted) => { released.push(granted); } };
      const runner = new PlaywrightSurface({ browser: odd });
      await expect(runner.prepare(prepareInfo(1))).rejects.toMatchObject({
        message: expect.stringContaining('browser provider "odd" returned a lease without an id and a cdpEndpoint'),
      });
      await runner.finish(finishInfo());
      expect(released).toEqual([]);
    }
  });

  it('fails init when prepare left nothing it can read, or the slot is outside the leases', async () => {
    const cloud = provider();
    const { env } = await prepared(cloud.impl, 1);
    const variable = leasesVariableIn(env);
    await expect(new PlaywrightSurface({ browser: cloud.impl }).init(initInfo(0))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" prepared nothing for target "web"'),
    });
    for (const raw of ['not json', '[]', '{"slots":1,"leases":[{"id":"x"}]}', '{"slots":-1,"leases":[]}']) {
      await expect(new PlaywrightSurface({ browser: cloud.impl }).init(initInfo(0, { [variable]: raw }))).rejects.toMatchObject({
        message: expect.stringContaining('prepared nothing for target "web"'),
      });
    }
    await expect(new PlaywrightSurface({ browser: cloud.impl }).init(initInfo(1, { [variable]: env[variable] }))).rejects.toMatchObject({
      message: expect.stringContaining('worker slot 1 is outside the 1 browser(s) "toy-cloud" leased'),
    });
    expect(connectCdp).not.toHaveBeenCalled();
  });

  it('leases a replacement in the worker once its browser dropped, releases only what the worker acquired, and the rest on dispose', async () => {
    const cloud = provider();
    const browsers: ReturnType<typeof fakeBrowser>[] = [];
    vi.mocked(connectCdp).mockImplementation(async (endpoint) => {
      const fake = fakeBrowser(`context-${endpoint}`);
      browsers.push(fake);
      return fake.browser;
    });
    const { runner, env } = await prepared(cloud.impl, 2);
    const variable = leasesVariableIn(env);
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, { [variable]: env[variable] }));
    await worker.startAttempt(attempt('a1'));
    await worker.endAttempt(cleanup());
    // A connected browser is kept across attempts: no new lease.
    expect(cloud.acquired).toHaveLength(2);

    browsers[0]!.drop();
    await worker.startAttempt(attempt('a2'));
    expect(vi.mocked(connectCdp).mock.calls.map(([endpoint]) => endpoint)).toEqual(['wss://0.example', 'wss://2.example']);
    // The replacement is asked for the same slot, from the worker, with no attempt id.
    expect(cloud.acquired.at(-1)).toMatchObject({ slot: 0, slots: 2, runId: 'run-1', targetName: 'web' });
    expect(cloud.acquired.at(-1)?.attemptId).toBeUndefined();
    // The dead lease came from prepare: the runner's finish releases it, not the worker.
    expect(cloud.released).toEqual([]);
    await worker.endAttempt(cleanup());

    browsers[1]!.drop();
    await worker.startAttempt(attempt('a3'));
    // A dead replacement is the worker's own to release.
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-2']);
    await worker.endAttempt(cleanup());
    await worker.dispose(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-2', 'lease-3']);

    await runner.finish(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-2', 'lease-3', 'lease-0', 'lease-1']);
  });

  it('releases the replacement on dispose even when ending the attempt failed', async () => {
    const cloud = provider();
    const fake = fakeBrowser('context');
    vi.mocked(connectCdp).mockResolvedValue(fake.browser);
    const { env } = await prepared(cloud.impl, 1);
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    fake.drop();
    await worker.startAttempt(attempt('a1'));
    expect(cloud.acquired).toHaveLength(2);
    vi.spyOn(worker, 'endAttempt').mockRejectedValueOnce(new Error('trace flush failed'));
    await expect(worker.dispose(cleanup())).rejects.toThrow(/trace flush failed/);
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-1']);
  });

  it('gives back a replacement that arrives after the worker was disposed, and never commits it', async () => {
    const cloud = provider();
    const fake = fakeBrowser('context');
    vi.mocked(connectCdp).mockResolvedValue(fake.browser);
    const { env } = await prepared(cloud.impl, 1);
    let grant!: () => void;
    const granted = new Promise<void>((resolve) => { grant = resolve; });
    const inner = cloud.impl.acquire.bind(cloud.impl);
    let requested = false;
    cloud.impl.acquire = async (request) => { requested = true; await granted; return inner(request); };
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    fake.drop();
    // Disposing ends the pending attempt, so the start fails as soon as dispose runs.
    const starting = expect(worker.startAttempt(attempt('a1'))).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => requested).toBe(true);
    // The connection's dispose waits on the pending attach; the cleanup budget cuts that short.
    await worker.dispose({ timeoutMs: 50, signal: new AbortController().signal });
    await starting;
    expect(cloud.released).toEqual([]);
    grant();
    await expect.poll(() => cloud.released.map((lease) => lease.id)).toEqual(['lease-1']);
    expect(vi.mocked(connectCdp).mock.calls.map(([endpoint]) => endpoint)).toEqual(['wss://0.example']);
  });

  it('fails the attempt start, naming the provider, when no replacement can be leased', async () => {
    const cloud = provider();
    const fake = fakeBrowser('context');
    vi.mocked(connectCdp).mockResolvedValue(fake.browser);
    const { env } = await prepared(cloud.impl, 1);
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    fake.drop();
    cloud.impl.acquire = async () => { throw new Error('quota exhausted'); };
    await expect(worker.startAttempt(attempt('a1'))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not lease a browser: quota exhausted'),
    });
    await worker.endAttempt(cleanup());
    await worker.dispose(cleanup());
    expect(cloud.released).toEqual([]);
  });
});

describe('attempt scope', () => {
  it('leases nothing at prepare, hands the workers the slot count alone, and attaches nothing at init', async () => {
    const cloud = provider({ scope: 'attempt' });
    const runner = new PlaywrightSurface({ browser: cloud.impl });
    const result = await runner.prepare(prepareInfo(2));
    expect(result?.workers).toBeUndefined();
    const env = result?.env ?? {};
    expect(JSON.parse(env[leasesVariableIn(env)]!)).toEqual({ slots: 2, leases: [] });
    expect(await runner.prepare(prepareInfo(0))).toEqual({});
    await runner.init(initInfo(0, env));
    expect(cloud.acquired).toEqual([]);
    expect(connectCdp).not.toHaveBeenCalled();
    await runner.finish(finishInfo());
    expect(cloud.released).toEqual([]);
  });

  it('leases a browser per attempt with the attempt id, attaches to it, and releases it at endAttempt, once', async () => {
    const cloud = provider({ scope: 'attempt' });
    const { env } = await prepared(cloud.impl, 2);
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(1, { ...env, BROWSER_TOKEN: 't' }));
    await worker.startAttempt(attempt('a1'));
    expect(cloud.acquired.map((request) => [request.slot, request.slots, request.attemptId, request.env])).toEqual([[1, 2, 'a1', { ...env, BROWSER_TOKEN: 't' }]]);
    expect(vi.mocked(connectCdp).mock.calls.map(([endpoint]) => endpoint)).toEqual(['wss://0.example']);
    await worker.endAttempt(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
    expect(cloud.released[0]).toHaveProperty('secret');
    await worker.endAttempt(cleanup());
    expect(cloud.released).toHaveLength(1);

    await worker.startAttempt(attempt('a2'));
    expect(cloud.acquired.at(-1)).toMatchObject({ attemptId: 'a2' });
    expect(vi.mocked(connectCdp).mock.calls.map(([endpoint]) => endpoint)).toEqual(['wss://0.example', 'wss://1.example']);
    await worker.dispose(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
  });

  it('releases the lease at endAttempt after a start that failed to attach', async () => {
    const cloud = provider({ scope: 'attempt' });
    vi.mocked(connectCdp).mockRejectedValue(new Error('endpoint refused'));
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
    await expect(worker.startAttempt(attempt('a1'))).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(cloud.acquired).toHaveLength(1);
    expect(cloud.released).toEqual([]);
    await worker.endAttempt(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });

  it('fails the attempt start, naming the provider, when the lease is refused, and endAttempt has nothing to release', async () => {
    const cloud = provider({ scope: 'attempt', failSlot: 0 });
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
    await expect(worker.startAttempt(attempt('a1'))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not lease a browser: no capacity for slot 0'),
    });
    expect(connectCdp).not.toHaveBeenCalled();
    await worker.endAttempt(cleanup());
    expect(cloud.released).toEqual([]);
  });

  it('reports an acquire that gave up on the aborted attempt as CANCELLED, not a provider failure', async () => {
    const cloud = provider({ scope: 'attempt' });
    cloud.impl.acquire = async (request) => {
      await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted by the service client');
    };
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(provider({ scope: 'attempt' }).impl, 1)).env));
    const controller = new AbortController();
    const starting = worker.startAttempt({ attemptId: 'a1', artifactsDir: '/tmp/e2e-provider-artifacts', signal: controller.signal });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    await worker.endAttempt(cleanup());
    expect(cloud.released).toEqual([]);
  });

  it('gives back a lease that arrives after the attempt was cancelled or ended, and never commits it', async () => {
    for (const how of ['aborted', 'ended'] as const) {
      const cloud = provider({ scope: 'attempt' });
      let grant!: () => void;
      const granted = new Promise<void>((resolve) => { grant = resolve; });
      const inner = cloud.impl.acquire.bind(cloud.impl);
      cloud.impl.acquire = async (request) => { await granted; return inner(request); };
      const worker = new PlaywrightSurface({ browser: cloud.impl });
      await worker.init(initInfo(0, (await prepared(provider({ scope: 'attempt' }).impl, 1)).env));
      const controller = new AbortController();
      const starting = worker.startAttempt({ attemptId: 'a1', artifactsDir: '/tmp/e2e-provider-artifacts', signal: controller.signal });
      if (how === 'aborted') controller.abort();
      else await worker.endAttempt(cleanup());
      grant();
      await expect(starting).rejects.toMatchObject({ code: 'CANCELLED', message: expect.stringContaining('arrived after the attempt ended; released') });
      expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
      expect(connectCdp).not.toHaveBeenCalled();
      // The next attempt starts clean and leases its own browser.
      await worker.startAttempt(attempt('a2'));
      expect(cloud.acquired.at(-1)).toMatchObject({ attemptId: 'a2' });
      await worker.dispose(cleanup());
      expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
      vi.mocked(connectCdp).mockClear();
    }
  });

  it('reports a release that failed as a cleanup error, once, and never holds the lease again', async () => {
    const cloud = provider({ scope: 'attempt', failRelease: true });
    const worker = new PlaywrightSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
    await worker.startAttempt(attempt('a1'));
    await expect(worker.endAttempt(cleanup())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not release browser lease-0: stop failed'),
    });
    await worker.endAttempt(cleanup());
    expect(cloud.released).toHaveLength(1);
  });

  it('reattaches through the lease\'s reconnectEndpoint after the transport drops, and through cdpEndpoint without one', async () => {
    for (const reconnect of [true, false]) {
      vi.mocked(connectCdp).mockReset();
      const fakes: ReturnType<typeof fakeBrowser>[] = [];
      vi.mocked(connectCdp).mockImplementation(async () => {
        // One browser identity: recovery must land on the same persistent context.
        const fake = fakeBrowser('same-browser');
        fakes.push(fake);
        return fake.browser;
      });
      const cloud = provider({ scope: 'attempt', reconnect });
      const worker = new PlaywrightSurface({ browser: cloud.impl });
      await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
      await worker.startAttempt(attempt('a1'));
      fakes[0]!.drop();
      await expect(worker.guard(operation(), 'probe', async () => 'reattached')).resolves.toBe('reattached');
      expect(vi.mocked(connectCdp).mock.calls.map(([endpoint]) => endpoint)).toEqual([
        'wss://0.example',
        reconnect ? 'wss://0.example/reconnect' : 'wss://0.example',
      ]);
      // Recovery is the same browser: no second lease.
      expect(cloud.acquired).toHaveLength(1);
      await worker.dispose(cleanup());
      expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
    }
  });
});
