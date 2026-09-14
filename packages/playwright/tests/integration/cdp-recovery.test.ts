/** Real CDP transport drops preserve only the dedicated persistent context, never a replacement. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import { playwright, surfaceOf, type PlaywrightConnectOptions, type Web } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

/** One operation's budget, independent of model calls or the runner's test timeout. */
function operation(timeoutMs = 10_000, signal = new AbortController().signal): OperationContext {
  return { timeoutMs, signal, runId: 'run-recovery', attemptId: 'a1', origin: 'test' };
}

/** Cleanup owns transports; the test host owns terminating Chrome. */
function cleanup() {
  return { timeoutMs: 10_000, signal: new AbortController().signal };
}

const heading = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } } as const;

describe('CDP session recovery', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  const activeEngines = new Set<EngineHandle>();
  const activeHosts = new Set<RemoteChrome>();

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-recovery-'));
  });

  afterAll(async () => {
    await app?.close();
    if (artifactsDir !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all([...activeEngines].map((engine) => engine.dispose!(cleanup())));
    await Promise.all([...activeHosts].map(closeRemoteChrome));
    activeEngines.clear();
    activeHosts.clear();
  });

  /** Registers the host before attempt setup, so a failed setup cannot leak Chrome. */
  async function host(): Promise<RemoteChrome> {
    const remote = await launchRemoteChrome();
    activeHosts.add(remote);
    return remote;
  }

  /** Supplies the engine fixture with the same operation budget as its caller. */
  function webOf(engine: EngineHandle, timeoutMs = 10_000): Web {
    return engine.fixtures!['web']!({
      operation: () => operation(timeoutMs),
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext) as Web;
  }

  /** Starts the engine's attempt against a host-provisioned browser. */
  async function start(connect: PlaywrightConnectOptions): Promise<EngineHandle> {
    const engine = playwright({ connect });
    activeEngines.add(engine);
    await engine.init!({
      runId: 'run-recovery', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false,
      workerSlot: 0, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal });
    await engine.session!.open!(`${app.url}/login`, operation());
    return engine;
  }

  it('keeps the exact page, document state, storage, viewport, routes, and dialog handlers', async () => {
    const remote = await host();
    let provisioned = 0;
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => { provisioned += 1; return remote.endpoint; },
      reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
    });
    try {
      const live = surfaceOf(engine)!;
      const original = live.page();
      await original.setViewportSize({ width: 800, height: 600 });
      await original.evaluate(() => {
        sessionStorage.setItem('attempt', 'kept');
        localStorage.setItem('login', 'kept');
        document.cookie = 'session=kept';
        (document.querySelector('input[name=user]') as HTMLInputElement).value = 'unsaved';
      });
      const stale = (await engine.locate!(heading, operation()))[0]!;
      const observation = await engine.observe!(operation());
      // Another tab at the same URL makes URL-based selection ambiguous.
      const other = await live.context().newPage();
      await other.goto(original.url());
      await other.locator('h1').evaluate((node) => { node.textContent = 'Wrong tab'; });

      const web = webOf(engine);
      await web.route('**/kept-route', (route) => route.fulfill({ body: 'route kept' }));
      await web.onDialog('accept');
      await original.context().browser()!.close();

      expect((await engine.locate!(heading, operation()))[0]?.name).toBe('Login');
      const recovered = live.page();
      expect(recovered).not.toBe(original);
      expect(await recovered.locator('input[name=user]').inputValue()).toBe('unsaved');
      expect(await recovered.evaluate(() => [sessionStorage.getItem('attempt'), localStorage.getItem('login'), document.cookie]))
        .toEqual(['kept', 'kept', 'session=kept']);
      expect(recovered.viewportSize()).toEqual({ width: 800, height: 600 });
      expect(await recovered.evaluate(async () => (await fetch('/kept-route')).text())).toBe('route kept');
      expect(await recovered.evaluate(() => confirm('Handler survived?'))).toBe(true);
      await expect(engine.perform!(stale.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await expect(engine.perform!(observation.root.ref, { kind: 'swipe', direction: 'down' }, operation()))
        .rejects.toMatchObject({ code: 'NODE_STALE' });
      await expect(engine.tapAt!({ x: 1, y: 1 }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await engine.observe!(operation());
      await engine.tapAt!({ x: 1, y: 1 }, operation());
      expect(provisioned).toBe(1);
      expect(reconnected).toBe(1);
    } finally {
      const browser = surfaceOf(engine)!.context().browser()!;
      await engine.dispose!(cleanup());
      expect(browser.isConnected()).toBe(false);
      expect(remote.proc.exitCode).toBeNull();
      expect(remote.proc.signalCode).toBeNull();
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('fails an uncertain click without reconnecting or dispatching it twice', async () => {
    const remote = await host();
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
    });
    try {
      const page = surfaceOf(engine)!.page();
      await page.evaluate(() => {
        sessionStorage.setItem('clicks', '0');
        const button = document.createElement('button');
        button.textContent = 'Purchase';
        button.addEventListener('click', () => {
          sessionStorage.setItem('clicks', String(Number(sessionStorage.getItem('clicks')) + 1));
          // Pause after the mutation so the transport disappears before click completion.
          // oxlint-disable-next-line no-debugger -- a real CDP pause makes the disconnect deterministic
          debugger;
        });
        document.body.append(button);
      });
      const debuggerSession = await page.context().newCDPSession(page);
      await debuggerSession.send('Debugger.enable');
      debuggerSession.once('Debugger.paused', () => { void page.context().browser()!.close(); });
      const [button] = await engine.locate!({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Purchase', exact: true } } }, operation());
      await expect(engine.perform!(button!.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ retryable: false });
      expect(reconnected).toBe(0);
      await engine.observe!(operation());
      expect(await surfaceOf(engine)!.page().evaluate(() => sessionStorage.getItem('clicks'))).toBe('1');
      expect(reconnected).toBe(1);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('rejects a different browser and never falls back to the provisioning resolver', async () => {
    const remote = await host();
    const replacement = await host();
    let provisioned = 0;
    const engine = await start({
      cdpEndpoint: () => { provisioned += 1; return remote.endpoint; },
      reconnectEndpoint: () => replacement.endpoint,
    });
    try {
      await surfaceOf(engine)!.context().browser()!.close();
      await expect(engine.observe!(operation())).rejects.toThrow(/different browser/);
      await expect(engine.observe!(operation())).rejects.toThrow(/different browser/);
      expect(provisioned).toBe(1);
      expect(replacement.proc.exitCode).toBeNull();
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
      await closeRemoteChrome(replacement);
    }
  }, 60_000);

  it('rejects a missing active target even when another tab has the same URL', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    try {
      const page = surfaceOf(engine)!.page();
      const other = await page.context().newPage();
      await other.goto(page.url());
      await page.close();
      await page.context().browser()!.close();
      await expect(engine.observe!(operation())).rejects.toThrow(/original page no longer exists/);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('bounds a hung reconnect resolver and propagates cancellation to it', async () => {
    const remote = await host();
    let signal: AbortSignal | undefined;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: (abort) => { signal = abort; return new Promise<string>(() => undefined); },
    });
    try {
      await surfaceOf(engine)!.context().browser()!.close();
      await expect(engine.observe!(operation(50))).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(signal?.aborted).toBe(true);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('provisions a fresh browser for each attempt and refuses accidental reuse', async () => {
    const hosts: RemoteChrome[] = [];
    let provisioned = 0;
    let reuse = false;
    const engine = await start({
      cdpEndpoint: async () => {
        provisioned += 1;
        if (!reuse) hosts.push(await host());
        return hosts.at(-1)!.endpoint;
      },
      reconnectEndpoint: () => hosts.at(-1)!.endpoint,
    });
    try {
      await surfaceOf(engine)!.page().evaluate(() => { localStorage.setItem('attempt', 'a1'); });
      await engine.endAttempt!(cleanup());
      await engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
      await engine.session!.open!(`${app.url}/login`, operation());
      expect(await surfaceOf(engine)!.page().evaluate(() => localStorage.getItem('attempt'))).toBeNull();
      expect(provisioned).toBe(2);
      await engine.endAttempt!(cleanup());
      reuse = true;
      await expect(engine.startAttempt!({ attemptId: 'a3', artifactsDir, signal: new AbortController().signal }))
        .rejects.toThrow(/reused a browser/);
    } finally {
      await engine.dispose!(cleanup());
      await Promise.all(hosts.map(closeRemoteChrome));
    }
  }, 60_000);

  it('shares recovery between concurrent operations while a cancelled waiter dispatches nothing', async () => {
    const remote = await host();
    let resolveEndpoint!: (endpoint: string) => void;
    let notifyRequested!: () => void;
    const endpoint = new Promise<string>((resolve) => { resolveEndpoint = resolve; });
    const requested = new Promise<void>((resolve) => { notifyRequested = resolve; });
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => {
        reconnected += 1;
        notifyRequested();
        return endpoint;
      },
    });
    await surfaceOf(engine)!.context().browser()!.close();
    const first = engine.locate!(heading, operation());
    await requested;
    const controller = new AbortController();
    const cancelled = engine.session!.open!(`${app.url}/form`, operation(10_000, controller.signal));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    resolveEndpoint(remote.endpoint);
    expect((await first)[0]?.name).toBe('Login');
    expect(surfaceOf(engine)!.page().url()).toBe(`${app.url}/login`);
    expect(reconnected).toBe(1);
  });

  it('counts reconnect time against the operation budget', async () => {
    const remote = await host();
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return remote.endpoint;
      },
    });
    await surfaceOf(engine)!.context().browser()!.close();
    await expect(webOf(engine, 500).evaluate(async () => {
      document.body.dataset['started'] = 'true';
      await new Promise((resolve) => setTimeout(resolve, 350));
      return 'too late';
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await surfaceOf(engine)!.page().getAttribute('body', 'data-started')).toBe('true');
  });

  it('resumes video and trace recording on the recovered page', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await engine.artifacts!.startVideo!(operation());
    await engine.artifacts!.startTrace!(operation());
    await surfaceOf(engine)!.page().screenshot();
    await surfaceOf(engine)!.context().browser()!.close();
    await engine.observe!(operation());
    const page = surfaceOf(engine)!.page();
    await page.evaluate(() => { document.body.style.background = 'blue'; });
    await page.screenshot();
    // The first segment may be lost during disconnect; the new segment must finalize.
    await engine.artifacts!.stopVideo!(operation()).catch((cause: unknown) => {
      expect(cause).toMatchObject({ code: 'ENGINE_FAILURE' });
    });
    await engine.artifacts!.stopTrace!(operation());
    const video = path.join(artifactsDir, 'video/video-part2.webm');
    expect(existsSync(video)).toBe(true);
    expect(statSync(video).size).toBeGreaterThan(0);
    expect(existsSync(path.join(artifactsDir, 'trace/trace.zip'))).toBe(true);
  }, 60_000);

  it('recovers before arming a download waiter and runs its trigger once', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await surfaceOf(engine)!.page().evaluate(() => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(['download kept']));
      link.download = 'kept.txt';
      link.id = 'download';
      link.textContent = 'Download';
      document.body.append(link);
    });
    await surfaceOf(engine)!.context().browser()!.close();
    let triggered = 0;
    const download = await webOf(engine).waitForDownload(async () => {
      triggered += 1;
      await surfaceOf(engine)!.page().locator('#download').click();
    });
    expect(triggered).toBe(1);
    expect(readFileSync(path.join(artifactsDir, download.path), 'utf8')).toBe('download kept');
    const failure = new Error('test trigger failed');
    await expect(webOf(engine).waitForDownload(async () => { throw failure; })).rejects.toBe(failure);
  });
});
