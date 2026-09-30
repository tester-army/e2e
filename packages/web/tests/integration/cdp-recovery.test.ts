/** Real CDP transport drops preserve only the dedicated persistent context, never a replacement. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import type { EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web as webEngine, surfaceOf, type WebConnectOptions, type Browser } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';
import { noSecrets } from '../helpers/secrets.ts';

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
  function fixtureOf(engine: EngineHandle, timeoutMs = 10_000): Browser {
    return engine.fixtures!['browser']!({
      operation: () => operation(timeoutMs),
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext) as Browser;
  }

  /** Starts the engine's attempt against a host-provisioned browser. */
  async function start(connect: WebConnectOptions): Promise<EngineHandle> {
    const engine = webEngine({ connect });
    activeEngines.add(engine);
    await engine.init!({
      runId: 'run-recovery', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false,
      workerSlot: 0, signal: new AbortController().signal, log: () => undefined,
    });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets });
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

      const fixture = fixtureOf(engine);
      await fixture.route('**/kept-route', (route) => route.fulfill({ body: 'route kept' }));
      await fixture.onDialog('accept');
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
      await expect(engine.performAt!({ x: 1, y: 1 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await engine.observe!(operation());
      await engine.performAt!({ x: 1, y: 1 }, { kind: 'tap' }, operation());
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
      await expect(engine.observe!(operation(50))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
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
      await engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets });
      await engine.session!.open!(`${app.url}/login`, operation());
      expect(await surfaceOf(engine)!.page().evaluate(() => localStorage.getItem('attempt'))).toBeNull();
      expect(provisioned).toBe(2);
      await engine.endAttempt!(cleanup());
      reuse = true;
      await expect(engine.startAttempt!({ attemptId: 'a3', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets }))
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
    await expect(fixtureOf(engine, 500).evaluate(async () => {
      document.body.dataset['started'] = 'true';
      await new Promise((resolve) => setTimeout(resolve, 350));
      return 'too late';
    })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
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
    const download = await fixtureOf(engine).waitForDownload(async () => {
      triggered += 1;
      await surfaceOf(engine)!.page().locator('#download').click();
    });
    expect(triggered).toBe(1);
    expect(readFileSync(path.join(artifactsDir, download.path), 'utf8')).toBe('download kept');
    const failure = new Error('test trigger failed');
    await expect(fixtureOf(engine).waitForDownload(async () => { throw failure; })).rejects.toBe(failure);
  });

  it('allows direct test-code mouse input using current geometry while observation-derived taps stay stale', async () => {
    const remote = await host();
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
    });
    const original = surfaceOf(engine)!.page();
    await original.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'pointer-target';
      button.textContent = 'Count';
      button.style.cssText = 'position:fixed;left:20px;top:200px;width:120px;height:50px';
      button.addEventListener('click', () => {
        document.body.dataset['clicks'] = String(Number(document.body.dataset['clicks'] ?? 0) + 1);
      });
      document.addEventListener('wheel', (event) => {
        document.body.dataset['wheel'] = String(event.deltaY);
        event.preventDefault();
      }, { passive: false });
      document.body.append(button);
    });
    await engine.observe!(operation());
    await original.locator('#pointer-target').evaluate((button) => { (button as HTMLElement).style.left = '260px'; });
    await original.context().browser()!.close();

    const fixture = fixtureOf(engine);
    const point = await fixture.evaluate(() => {
      const bounds = document.querySelector('#pointer-target')!.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    });
    expect(point.x).toBe(320);
    expect(reconnected).toBe(1);
    await fixture.mouse.move(point.x, point.y);
    await fixture.mouse.down();
    await fixture.mouse.up();
    await fixture.mouse.wheel(0, 25);
    await expect.poll(() => fixture.evaluate(() => document.body.dataset['wheel'] ?? null)).toBe('25');
    expect(await fixture.evaluate(() => document.body.dataset['clicks'] ?? null)).toBe('1');

    await expect(engine.performAt!(point, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await engine.observe!(operation());
    await engine.performAt!(point, { kind: 'tap' }, operation());
    expect(await fixture.evaluate(() => document.body.dataset['clicks'] ?? null)).toBe('2');
  });

  it('requires new evidence for focused engine keyboard input after recovery while direct test input remains available', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    const page = surfaceOf(engine)!.page();
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'keyboard-target';
      field.value = 'original';
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') document.body.dataset['enters'] = String(Number(document.body.dataset['enters'] ?? 0) + 1);
      });
      document.body.append(field);
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await engine.observe!(operation());
    await page.context().browser()!.close();
    await expect(engine.keyboard!.type('replacement', { replace: true }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(engine.keyboard!.press('Enter', operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    const fixture = fixtureOf(engine);
    const value = () => fixture.evaluate(() => (document.querySelector('#keyboard-target') as HTMLInputElement).value);
    expect(await value()).toBe('original');
    expect(await fixture.evaluate(() => document.body.dataset['enters'] ?? '0')).toBe('0');
    await fixture.keyboard.type(' direct');
    await fixture.keyboard.press('Enter');
    expect(await value()).toBe('original direct');
    expect(await fixture.evaluate(() => document.body.dataset['enters'] ?? '0')).toBe('1');
    await expect(engine.keyboard!.press('Enter', operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await engine.observe!(operation());
    await engine.keyboard!.type('replacement', { replace: true }, operation());
    await engine.keyboard!.press('Enter', operation());
    expect(await value()).toBe('replacement');
    expect(await fixture.evaluate(() => document.body.dataset['enters'] ?? '0')).toBe('2');
  });

  it('rejects an observation that finishes during recovery and still requires new evidence', async () => {
    const remote = await host();
    let resumePixels!: () => void;
    let cleanupStarted!: () => void;
    let pixelsStarted!: () => void;
    let pixelsFailed!: (cause: unknown) => void;
    let resolveEndpoint!: (endpoint: string) => void;
    let requested!: () => void;
    const pixelsPaused = new Promise<void>((resolve) => { resumePixels = resolve; });
    const cleanupReached = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const pixelsReached = new Promise<void>((resolve, reject) => { pixelsStarted = resolve; pixelsFailed = reject; });
    const endpoint = new Promise<string>((resolve) => { resolveEndpoint = resolve; });
    const reconnectRequested = new Promise<void>((resolve) => { requested = resolve; });
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => { requested(); return endpoint; },
    });
    const page = surfaceOf(engine)!.page();
    const evaluateHandle = page.evaluateHandle.bind(page);
    const spy = vi.spyOn(page, 'evaluateHandle').mockImplementation(async (...args) => {
      const handle = await evaluateHandle(...args);
      const dispose = handle.dispose.bind(handle);
      vi.spyOn(handle, 'dispose').mockImplementation(async () => {
        await dispose();
        cleanupStarted();
      });
      return handle;
    });
    const screenshot = page.screenshot.bind(page);
    const pixelSpy = vi.spyOn(page, 'screenshot').mockImplementation(async (...args) => {
      const pixels = await screenshot(...args).catch((cause: unknown) => { pixelsFailed(cause); throw cause; });
      pixelsStarted();
      await pixelsPaused;
      return pixels;
    });
    try {
      const oldObservation = engine.observe!(operation(), { pixels: true }).catch((cause: unknown) => cause);
      await Promise.all([cleanupReached, pixelsReached]);
      await page.context().browser()!.close();
      const recovery = engine.locate!(heading, operation());
      await reconnectRequested;
      resumePixels();
      expect(await oldObservation).toMatchObject({ code: 'NODE_STALE' });
      resolveEndpoint(remote.endpoint);
      await recovery;
      await expect(engine.performAt!({ x: 20, y: 20 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await engine.observe!(operation());
      await engine.performAt!({ x: 20, y: 20 }, { kind: 'tap' }, operation());
    } finally {
      resumePixels();
      resolveEndpoint(remote.endpoint);
      spy.mockRestore();
      pixelSpy.mockRestore();
    }
  });

  it('masks password fields in light and closed shadow DOM before and after reconnect', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await surfaceOf(engine)!.page().evaluate(() => {
      document.body.innerHTML = '';
      document.body.style.background = 'blue';
      const field = document.createElement('input');
      field.type = 'password';
      field.value = 'private';
      field.style.cssText = 'position:fixed;left:20px;top:20px;width:180px;height:40px';
      document.body.append(field);
      const shadowHost = document.createElement('div');
      document.body.append(shadowHost);
      const root = shadowHost.attachShadow({ mode: 'closed' });
      const hiddenField = field.cloneNode(true) as HTMLInputElement;
      hiddenField.style.top = '80px';
      root.append(hiddenField);
    });
    for (const reconnect of [false, true]) {
      if (reconnect) await surfaceOf(engine)!.context().browser()!.close();
      const snapshot = await engine.observe!(operation(), { pixels: true });
      expect(snapshot.maskedRegionCount).toBe(2);
      expect(snapshot.pixels).toBeDefined();
      const image = decodePng(snapshot.pixels!.data);
      expect(image.pixelAt(40, 40)).toEqual([0, 0, 0, 255]);
      expect(image.pixelAt(40, 100)).toEqual([0, 0, 0, 255]);
      expect(image.pixelAt(300, 160)).toEqual([0, 0, 255, 255]);
    }
  });

  it('refuses recovery when disconnected navigation lost the closed-root tracking hook', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await surfaceOf(engine)!.context().browser()!.close();
    const hostControl = await chromium.connectOverCDP(remote.endpoint);
    try {
      const page = hostControl.contexts()[0]!.pages().find((candidate) => candidate.url().endsWith('/login'))!;
      await page.goto(`${app.url}/form`);
      const tracked = await page.evaluate(() => {
        const shadowHost = document.createElement('div');
        document.body.append(shadowHost);
        const root = shadowHost.attachShadow({ mode: 'closed' });
        root.innerHTML = '<input type="password" value="private">';
        return Object.prototype.hasOwnProperty.call(globalThis, Symbol.for('e2e.closedShadowRoots'));
      });
      expect(tracked).toBe(false);
      expect(await page.locator('body').count()).toBe(1);
    } finally {
      await hostControl.close();
    }
    await expect(engine.observe!(operation(), { pixels: true })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

});
