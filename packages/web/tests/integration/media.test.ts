/**
 * Media emulation in a real browser: `web({ colorScheme, reducedMotion })`
 * and `browser.emulateMedia` reach the page's own `@media` rules, not only
 * `matchMedia`, from the first paint of every page the attempt opens, through
 * `app.restart()` and `app.clearState()`. Driven through the engine hooks and
 * the `browser` fixture, as the attempt executor drives them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web, surfaceOf, type Browser, type WebMedia, type WebOptions } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-media', attemptId: 'm1', origin: 'test' };
}

/** What the media page shows: its paragraph's computed style, what `matchMedia` reports now, and what its head script read before first paint. */
interface MediaReading {
  readonly color: string;
  readonly transition: string;
  readonly dark: boolean;
  readonly reduce: boolean;
  readonly atLoad: { readonly dark: boolean; readonly reduce: boolean };
}

const LIGHT = 'rgb(0, 0, 0)';
const DARK = 'rgb(255, 255, 255)';

describe('media emulation', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-media-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Boots one engine into a running attempt, with no page open yet. */
  async function boot(options: WebOptions): Promise<EngineHandle> {
    const engine = web(options);
    await engine.init!({
      runId: 'run-media', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'm1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    return engine;
  }

  async function shutdown(engine: EngineHandle): Promise<void> {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  }

  /** The engine's `browser` fixture, with the harness parts it reaches stubbed. */
  function fixtureOf(engine: EngineHandle): Browser {
    return engine.fixtures!['browser']!({
      operation,
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext) as Browser;
  }

  async function openMedia(engine: EngineHandle): Promise<MediaReading> {
    await engine.session!.open!(`${app.url}/media`, operation());
    return read(engine);
  }

  function read(engine: EngineHandle): Promise<MediaReading> {
    return surfaceOf(engine)!.page().evaluate(() => {
      const style = getComputedStyle(document.querySelector('p')!);
      return {
        color: style.color,
        transition: style.transitionDuration,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        atLoad: (window as unknown as { atLoad: MediaReading['atLoad'] }).atLoad,
      };
    });
  }

  /** The reading of a page that loaded with `media` in force. */
  function loadedWith(media: { dark: boolean; reduce: boolean }): MediaReading {
    return { color: media.dark ? DARK : LIGHT, transition: media.reduce ? '0s' : '0.3s', ...media, atLoad: media };
  }

  it('loads every page with the configured media, after a restart and a context reset too', async () => {
    const engine = await boot({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const expected = loadedWith({ dark: true, reduce: true });
    try {
      expect(await openMedia(engine)).toEqual(expected);
      await engine.session!.restart!(operation());
      expect(await openMedia(engine)).toEqual(expected);
      await engine.session!.reset!(operation());
      expect(await openMedia(engine)).toEqual(expected);
    } finally {
      await shutdown(engine);
    }
  });

  it('leaves the browser\'s own media when none is configured', async () => {
    const engine = await boot({});
    try {
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: false, reduce: false }));
    } finally {
      await shutdown(engine);
    }
  });

  it('emulates media set before the first navigation from first paint, and holds a change for the rest of the attempt', async () => {
    const engine = await boot({ colorScheme: 'dark' });
    const browser = fixtureOf(engine);
    try {
      await browser.emulateMedia({ reducedMotion: 'reduce' });
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: true, reduce: true }));
      // A change applies to the open page at once; a feature left out keeps its value.
      await browser.emulateMedia({ colorScheme: 'light' });
      expect(await read(engine)).toEqual({ ...loadedWith({ dark: false, reduce: true }), atLoad: { dark: true, reduce: true } });
      const expected = loadedWith({ dark: false, reduce: true });
      await engine.session!.restart!(operation());
      expect(await openMedia(engine)).toEqual(expected);
      await engine.session!.reset!(operation());
      expect(await openMedia(engine)).toEqual(expected);
      await browser.emulateMedia({ colorScheme: 'no-preference', reducedMotion: 'no-preference' });
      expect(await read(engine)).toMatchObject({ color: LIGHT, transition: '0.3s', dark: false, reduce: false });
    } finally {
      await shutdown(engine);
    }
  });

  it('gives a tab the app opens itself a test\'s change as it appears and later', async () => {
    const engine = await boot({ colorScheme: 'dark' });
    try {
      await fixtureOf(engine).emulateMedia({ colorScheme: 'light' });
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: false, reduce: false }));
      const live = surfaceOf(engine)!;
      const [popup] = await Promise.all([
        live.context().waitForEvent('page'),
        live.page().evaluate(() => { window.open('/media'); }),
      ]);
      await popup.waitForLoadState('load');
      const now = () => popup.evaluate(() => ({
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }));
      expect(await now()).toEqual({ dark: false, reduce: false });
      await fixtureOf(engine).emulateMedia({ reducedMotion: 'reduce' });
      expect(await now()).toEqual({ dark: false, reduce: true });
      expect(await read(engine)).toMatchObject({ dark: false, reduce: true });
    } finally {
      await shutdown(engine);
    }
  });

  it('refuses a feature it does not emulate and a value outside the ones it takes, changing nothing', async () => {
    const engine = await boot({ colorScheme: 'dark' });
    const browser = fixtureOf(engine);
    const refused = (message: string) => expect.objectContaining({ code: 'INVALID_ARGUMENT', message });
    try {
      await expect(browser.emulateMedia({ colorScheme: 'sepia' } as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia({ colorScheme }) must be "light", "dark", or "no-preference", got "sepia"'),
      );
      await expect(browser.emulateMedia({ forcedColors: 'active' } as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia options has no key "forcedColors"; it takes colorScheme, reducedMotion'),
      );
      await expect(browser.emulateMedia(undefined as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia takes { colorScheme?, reducedMotion? }'),
      );
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: true, reduce: false }));
    } finally {
      await shutdown(engine);
    }
  });
});
