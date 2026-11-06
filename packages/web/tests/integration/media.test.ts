/**
 * Media emulation in a real browser: `web({ colorScheme, reducedMotion })`
 * and `browser.emulateMedia` reach the page's own `@media` rules, not only
 * `matchMedia`, from the first paint of every page the attempt opens, through
 * `app.restart()` and `app.clearState()`. Driven through the engine hooks and
 * the `browser` fixture, as the attempt executor drives them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebMedia, WebOptions } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

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

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Boots one engine into a running attempt, with no page open yet. */
  function boot(options: WebOptions): Promise<WebSession> {
    return startWebSession({ web: options });
  }

  async function shutdown(engine: WebSession): Promise<void> {
    await engine.close();
  }

  async function openMedia(engine: WebSession): Promise<MediaReading> {
    await engine.open(`${app.url}/media`);
    return read(engine);
  }

  async function read(engine: WebSession): Promise<MediaReading> {
    return (await engine.browser.evaluate(() => {
      const style = getComputedStyle(document.querySelector('p')!);
      return {
        color: style.color,
        transition: style.transitionDuration,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        atLoad: (window as unknown as { atLoad: MediaReading['atLoad'] }).atLoad,
      };
    })) as unknown as MediaReading;
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
      await engine.engine.session!.restart!(engine.op());
      expect(await openMedia(engine)).toEqual(expected);
      await engine.engine.session!.reset!(engine.op());
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
    const { browser } = engine;
    try {
      await browser.emulateMedia({ reducedMotion: 'reduce' });
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: true, reduce: true }));
      // A change applies to the open page at once; a feature left out keeps its value.
      await browser.emulateMedia({ colorScheme: 'light' });
      expect(await read(engine)).toEqual({ ...loadedWith({ dark: false, reduce: true }), atLoad: { dark: true, reduce: true } });
      const expected = loadedWith({ dark: false, reduce: true });
      await engine.engine.session!.restart!(engine.op());
      expect(await openMedia(engine)).toEqual(expected);
      await engine.engine.session!.reset!(engine.op());
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
      await engine.browser.emulateMedia({ colorScheme: 'light' });
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: false, reduce: false }));
      // The opener reads the popup's own media through the handle window.open returned: both share one origin.
      await engine.browser.evaluate(async () => {
        const popup = window.open('/media')!;
        Reflect.set(window, 'popup', popup);
        while (popup.document.readyState !== 'complete' || popup.location.pathname !== '/media') await new Promise((resolve) => setTimeout(resolve, 20));
        return null;
      });
      const now = () => engine.browser.evaluate(() => {
        const popup = Reflect.get(window, 'popup') as Window;
        return {
          dark: popup.matchMedia('(prefers-color-scheme: dark)').matches,
          reduce: popup.matchMedia('(prefers-reduced-motion: reduce)').matches,
        };
      });
      expect(await now()).toEqual({ dark: false, reduce: false });
      await engine.browser.emulateMedia({ reducedMotion: 'reduce' });
      expect(await now()).toEqual({ dark: false, reduce: true });
      expect(await read(engine)).toMatchObject({ dark: false, reduce: true });
    } finally {
      await shutdown(engine);
    }
  });

  it('refuses a feature it does not emulate and a value outside the ones it takes, changing nothing', async () => {
    const engine = await boot({ colorScheme: 'dark' });
    const { browser } = engine;
    const refused = (message: string) => expect.objectContaining({ code: 'INVALID_ARGUMENT', message });
    // The harness records every fixture call as a step, so a refusal thrown before the call's promise is a rejection all the same.
    const emulate = (media: WebMedia) => Promise.resolve().then(() => browser.emulateMedia(media));
    try {
      await expect(emulate({ colorScheme: 'sepia' } as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia({ colorScheme }) must be "light", "dark", or "no-preference", got "sepia"'),
      );
      await expect(emulate({ forcedColors: 'active' } as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia options has no key "forcedColors"; it takes colorScheme, reducedMotion'),
      );
      await expect(emulate(undefined as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia takes { colorScheme?, reducedMotion? }'),
      );
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: true, reduce: false }));
    } finally {
      await shutdown(engine);
    }
  });
});
