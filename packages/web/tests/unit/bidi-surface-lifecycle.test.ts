/**
 * The surface's lifecycle on a scripted browser behind a browser provider
 * (the CDP attach mocked, as in browser-provider.test.ts): a reset given up
 * on never leaves the attempt between user contexts nor opens a tab later,
 * a failed setup keeps its cause while `endAttempt` tears down, an attach
 * the last attempt gave up on never holds up the next, and a video segment
 * that cannot start never fails the navigation that opened its tab.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAttemptContext, EngineCleanupContext, EngineInitInfo, OperationContext } from 'e2e/engine';
import { connectBidiOverCdp, type BidiBrowser } from '../../src/bidi/launch.ts';
import { web } from '../../src/index.ts';
import type { BrowserProvider } from '../../src/provider.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/bidi/launch.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), connectBidiOverCdp: vi.fn() }));
const connectCdp = vi.mocked(connectBidiOverCdp);

afterEach(() => {
  connectCdp.mockReset();
});

/** A scripted browser whose user contexts and tabs are numbered, refusing a tab in an empty user context as Chromium does. */
function fakeBrowser() {
  const peer = new FakeBidi();
  let userContexts = 0;
  let contexts = 0;
  peer.on('session.subscribe', { result: { subscription: 's' } })
    .on('browser.createUserContext', () => ({ result: { userContext: `uc-${++userContexts}` } }))
    .on('browsingContext.create', (params) => (params['userContext'] === '' ? { error: 'invalid argument', message: 'empty userContext' } : { result: { context: `ctx-${++contexts}` } }))
    .on('script.addPreloadScript', { result: { script: 'preload' } })
    .on('network.addIntercept', { result: { intercept: 'i' } })
    .on('browsingContext.getTree', { result: { contexts: [] } })
    .on('script.callFunction', { result: { type: 'success', result: { type: 'object', value: [['width', { type: 'number', value: 1280 }], ['height', { type: 'number', value: 720 }]] }, realm: 'r' } });
  const browser: BidiBrowser = { name: 'chromium', version: '157', connection: peer.connection, exclusive: false, close: async () => peer.drop() };
  return { browser, peer };
}

/** A provider of numbered leases in `scope`, recording what it released, whose release fails when asked to. */
function provider(scope: 'worker' | 'attempt', released: string[], failRelease = false): BrowserProvider {
  let n = 0;
  return {
    name: 'toy',
    scope,
    async acquire() {
      const i = n++;
      return { id: `lease-${i}`, cdpEndpoint: `wss://${i}.example` };
    },
    async release(lease) {
      released.push(lease.id);
      if (failRelease) throw new Error('release failed');
    },
  };
}

/** The worker environment `prepare` leaves for one slot of `browser`. */
async function prepared(browser: BrowserProvider): Promise<Record<string, string>> {
  const result = await web({ browser }).prepare!({ runId: 'run-1', targetName: 'web', projectRoot: '/project', app: {}, slots: 1, env: {}, signal: new AbortController().signal, headed: false, log: () => undefined });
  return { ...(result?.env as Record<string, string>) };
}

const info = (env: Record<string, string>): EngineInitInfo => ({ runId: 'run-1', targetName: 'web', projectRoot: '/project', app: {}, env, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
const attempt = (id: string, signal = new AbortController().signal): EngineAttemptContext => ({ attemptId: id, artifactsDir: '/tmp/e2e-lifecycle-artifacts', signal, resolveSecret: noSecrets, ...ignoreTrace });
const cleanup = (): EngineCleanupContext => ({ timeoutMs: 2_000, signal: new AbortController().signal });
const op = (timeoutMs = 2_000): OperationContext => ({ timeoutMs, signal: new AbortController().signal, runId: 'run-1', attemptId: 'a1', origin: 'test' });

describe('a reset given up on', () => {
  it('leaves the user context in use, and the one it opens late removes itself instead of opening a tab', async () => {
    const fake = fakeBrowser();
    connectCdp.mockImplementation(async () => fake.browser);
    const leases = provider('worker', []);
    const engine = web({ browser: leases });
    await engine.init!(info(await prepared(leases)));
    await engine.startAttempt!(attempt('a1'));
    await engine.session!.open!('https://app.test/', op());
    let land: () => void = () => undefined;
    fake.peer.on('browser.createUserContext', () => new Promise((resolve) => (land = () => resolve({ result: { userContext: 'uc-late' } }))));
    await expect(engine.session!.reset!(op(300))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect(engine.session!.open!('https://app.test/', op())).resolves.toBeUndefined();
    land();
    await vi.waitFor(() => expect(fake.peer.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toContain('uc-late'));
    expect(fake.peer.commands('browsingContext.create').map((command) => command.params['userContext'])).toEqual(['uc-1']);
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  });
});

describe('a failed attempt setup', () => {
  it('fails with its own cause, and endAttempt still gives the lease back once', async () => {
    const fake = fakeBrowser();
    fake.peer.on('script.addPreloadScript', { error: 'unknown error', message: 'SETUP BROKE' });
    connectCdp.mockImplementation(async () => fake.browser);
    const released: string[] = [];
    const leases = provider('attempt', released, true);
    const engine = web({ browser: leases });
    await engine.init!(info(await prepared(leases)));
    await expect(engine.startAttempt!(attempt('a1'))).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('SETUP BROKE') });
    await expect(engine.endAttempt!(cleanup())).rejects.toThrow('release failed');
    expect(released).toEqual(['lease-0']);
  });
});

describe('an attach the last attempt gave up on', () => {
  it('never holds up the next attempt, which attaches to its own lease at once', async () => {
    connectCdp.mockImplementation((endpoint) => new Promise<BidiBrowser>((_, reject) => setTimeout(() => reject(new Error(`slow endpoint ${endpoint}`)), endpoint.startsWith('wss://0') ? 3_000 : 0)));
    const leases = provider('attempt', []);
    const engine = web({ browser: leases });
    await engine.init!(info(await prepared(leases)));
    await expect(engine.startAttempt!(attempt('a1', AbortSignal.timeout(100)))).rejects.toMatchObject({ code: 'CANCELLED' });
    await engine.endAttempt!(cleanup());
    const started = Date.now();
    await expect(engine.startAttempt!(attempt('a2', AbortSignal.timeout(2_000)))).rejects.toThrow('slow endpoint wss://1.example');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(connectCdp.mock.calls.map(([endpoint]) => endpoint)).toEqual(['wss://0.example', 'wss://1.example']);
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  });
});

describe('a video segment that cannot start', () => {
  it('lets the navigation that opened its tab pass, and fails stopVideo instead', async () => {
    const fake = fakeBrowser();
    fake.peer.on('goog:cdp.getSession', { error: 'unknown error', message: 'no CDP session for this tab' });
    connectCdp.mockImplementation(async () => fake.browser);
    const leases = provider('worker', []);
    const engine = web({ browser: leases });
    await engine.init!(info({ ...(await prepared(leases)), E2E_FFMPEG_PATH: process.execPath }));
    await engine.startAttempt!(attempt('a1'));
    await engine.artifacts!.startVideo!(op());
    await expect(engine.session!.open!('https://app.test/', op())).resolves.toBeUndefined();
    await expect(engine.artifacts!.stopVideo!(op())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('no CDP session for this tab') });
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  });
});
