/** Clock configuration reaches document startup, new pages, frames, and replacement contexts. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type { EngineHandle, OperationContext } from 'e2e/engine';
import { web, surfaceOf, type PlaywrightLiveSurface, type WebOptions } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

interface ClockReading {
  time: number;
  created: number;
  intl: string;
  temporal: number | null;
  fired: boolean;
}

declare global {
  interface Window {
    clockProof: ClockReading;
    clockInit: number;
    clockScroll: number;
  }
}

const TIME = Date.parse('2032-01-02T03:04:05Z');
const BOOT = `<script>
window.clockProof = {
  time: Date.now(), created: +new Date(),
  intl: new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', dateStyle: 'short' }).format(),
  temporal: typeof Temporal === 'undefined' ? null : Temporal.Now.instant().epochMilliseconds,
  fired: false,
};
setTimeout(() => { window.clockProof.fired = true; }, 100);
document.addEventListener('scroll', () => { window.clockScroll = scrollY; });
</script>`;
const signal = new AbortController().signal;
const operation = (): OperationContext => ({ signal, timeoutMs: 30_000, runId: 'clock', attemptId: 'a', origin: 'test' });
const cleanup = () => ({ signal, timeoutMs: 30_000 });

describe('browser clock', () => {
  let server: Server;
  let cross: Server;
  let url: string;

  beforeAll(async () => {
    cross = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><head>${BOOT}</head><body>Frame</body></html>`);
    });
    await new Promise<void>(resolve => cross.listen(0, '127.0.0.1', resolve));
    const crossUrl = `http://127.0.0.1:${(cross.address() as AddressInfo).port}`;
    server = createServer((request, response) => {
      const frames = request.url === '/frames' ? `<iframe src="/"></iframe><iframe src="${crossUrl}/"></iframe>` : '';
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><head>${BOOT}</head><body>${frames}<div style="height:8000px">Scroll</div></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([server, cross].map(current => new Promise<void>((resolve, reject) => {
      current.close(error => error === undefined ? resolve() : reject(error));
    })));
  });

  async function attempt(options: WebOptions, body: (engine: EngineHandle, live: PlaywrightLiveSurface) => Promise<void>): Promise<void> {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-clock-'));
    const engine = web(options);
    try {
      await engine.init!({ runId: 'clock', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' },
        env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
      await body(engine, surfaceOf(engine)!);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }

  function reading(page: Page): Promise<ClockReading> {
    return page.evaluate(() => window.clockProof);
  }

  function expectTime(value: ClockReading, time: number): void {
    expect(value.time).toBe(time);
    expect(value.created).toBe(time);
    expect(value.intl).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', dateStyle: 'short' }).format(time));
    if (value.temporal !== null) expect(value.temporal).toBe(time);
  }

  it('sets the time before configured init scripts and document scripts, in frames and popups too', async () => {
    await attempt({ clock: { time: '2032-01-02T03:04:05Z', mode: 'paused' }, initScripts: ['window.clockInit = Date.now();'] }, async (engine, live) => {
      await engine.session!.open!(`${url}/frames`, operation());
      expectTime(await reading(live.page()), TIME);
      expect(await live.page().evaluate(() => window.clockInit)).toBe(TIME);
      const frames = live.page().frames().slice(1);
      expect(frames).toHaveLength(2);
      for (const frame of frames) {
        await frame.waitForLoadState();
        expectTime(await frame.evaluate(() => window.clockProof), TIME);
      }
      const opened = live.context().waitForEvent('page');
      await live.page().evaluate(() => { window.open('/'); });
      const popup = await opened;
      await popup.waitForLoadState();
      expectTime(await reading(popup), TIME);
    });
  });

  it.each([undefined, 'running'] as const)('advances time and fires page timers in %s mode', async mode => {
    await attempt({ clock: { time: 0, ...(mode === undefined ? {} : { mode }) } }, async (engine, live) => {
      await engine.session!.open!(url, operation());
      const boot = await reading(live.page());
      expect(boot.time).toBeGreaterThanOrEqual(0);
      expect(boot.time).toBeLessThan(TIME);
      await expect.poll(() => live.page().evaluate(() => window.clockProof.fired)).toBe(true);
      expect(await live.page().evaluate(() => Date.now())).toBeGreaterThan(boot.time);
    });
  });

  it('pauses time and page timers, without changing the host clock', async () => {
    await attempt({ clock: { time: -1, mode: 'paused' } }, async (engine, live) => {
      await engine.session!.open!(url, operation());
      expectTime(await reading(live.page()), -1);
      expect(Date.now()).toBeGreaterThan(0);
      expect((await reading(live.page())).fired).toBe(false);
      await live.context().clock.runFor(100);
      expect(await live.page().evaluate(() => Date.now())).toBe(99);
      expect((await reading(live.page())).fired).toBe(true);
    });
  });

  it('keeps the current time through navigation and restart, resetting it on context replacement and state restore', async () => {
    await attempt({ clock: { time: 0, mode: 'paused' } }, async (engine, live) => {
      await engine.session!.open!(url, operation());
      await live.page().evaluate(() => { localStorage.setItem('clock', 'saved'); });
      const state = await engine.state!.capture(operation());
      await live.context().clock.runFor(1_000);
      await engine.session!.open!(`${url}/next`, operation());
      expectTime(await reading(live.page()), 1_000);
      await engine.session!.restart!(operation());
      await engine.session!.open!(url, operation());
      expectTime(await reading(live.page()), 1_000);
      await engine.session!.reset!(operation());
      await engine.session!.open!(url, operation());
      expectTime(await reading(live.page()), 0);
      expect(await live.page().evaluate(() => localStorage.getItem('clock'))).toBeNull();
      await live.context().clock.runFor(2_000);
      await engine.state!.restore(state, operation());
      await engine.session!.open!(url, operation());
      expectTime(await reading(live.page()), 0);
      expect(await live.page().evaluate(() => localStorage.getItem('clock'))).toBe('saved');
    });
  });

  it('leaves an unconfigured browser on real time', async () => {
    const before = Date.now();
    await attempt({}, async (engine, live) => {
      await engine.session!.open!(url, operation());
      const boot = await reading(live.page());
      expect(boot.time).toBeGreaterThanOrEqual(before);
      expect(boot.time).toBeLessThanOrEqual(Date.now());
    });
  });

  it('finishes a swipe while page time and timers remain paused', async () => {
    await attempt({ clock: { time: 0, mode: 'paused' } }, async (engine, live) => {
      await engine.session!.open!(url, operation());
      await engine.performAt!({ x: 100, y: 100 }, { kind: 'swipe', direction: 'down', momentum: 'slow' }, { ...operation(), timeoutMs: 1_000 });
      expect(await live.page().evaluate(() => scrollY)).toBeGreaterThan(0);
      expect(await live.page().evaluate(() => window.clockScroll)).toBeGreaterThan(0);
      expect(await live.page().evaluate(() => Date.now())).toBe(0);
      expect((await reading(live.page())).fired).toBe(false);
    });
  });

  it.each(['point', 'root', 'node'] as const)('ends %s swipe polling within its budget without retrying dispatched input', async kind => {
    await attempt({ clock: { time: 0, mode: 'paused' } }, async (engine, live) => {
      await engine.session!.open!(url, operation());
      await live.page().evaluate(() => {
        const pane = document.createElement('div');
        pane.dataset.testid = 'scroll';
        pane.style.cssText = 'height:400px;overflow:auto';
        pane.innerHTML = '<div style="height:8000px">Scroll pane</div>';
        document.body.prepend(pane);
      });
      const snapshot = await engine.observe!(operation());
      const nodes = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'scroll', exact: true } } }, operation());
      await live.page().evaluate(() => { Object.defineProperty(document.timeline, 'currentTime', { value: 0 }); });
      const polling = vi.spyOn(live.page(), 'waitForFunction');
      const budget = { ...operation(), timeoutMs: 200 };
      const swipe = kind === 'point'
        ? engine.performAt!({ x: 100, y: 100 }, { kind: 'swipe', direction: 'down' }, budget)
        : engine.perform!(kind === 'root' ? snapshot.root.ref : nodes[0]!.ref, { kind: 'swipe', direction: 'down' }, budget);
      await expect(swipe).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      expect(polling).toHaveBeenCalledOnce();
      let failure: unknown;
      void polling.mock.results[0]?.value.catch((error: unknown) => { failure = error; });
      await Promise.resolve();
      expect(failure).toMatchObject({ name: 'TimeoutError' });
    });
  });
});
