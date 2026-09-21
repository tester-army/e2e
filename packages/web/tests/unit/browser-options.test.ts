/**
 * `context` and `launch` hand Playwright's own options through, minus the
 * keys the engine's bookkeeping owns; those, and a combination the engine
 * could not honour, fail at config load with the option that stands in.
 * What the browser does with accepted ones is in tests/integration.
 */

import { describe, expect, it } from 'vitest';
import { bringsOwnExecutable, resolveViewport } from '../../src/browser-options.ts';
import { web, type WebContextOptions, type WebLaunchOptions } from '../../src/index.ts';

const cdp = { cdpEndpoint: () => 'ws://localhost:9222' };

describe('web({ context })', () => {
  it('accepts Playwright context options, a device descriptor included', () => {
    expect(() =>
      web({
        context: {
          locale: 'de-DE',
          timezoneId: 'Europe/Warsaw',
          colorScheme: 'dark',
          ignoreHTTPSErrors: true,
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
          userAgent: 'phone',
          viewport: { width: 390, height: 664 },
          storageState: { cookies: [], origins: [] },
        },
      }),
    ).not.toThrow();
    expect(() => web({ context: {} })).not.toThrow();
  });

  it('refuses the keys the engine sets itself, naming the option that stands in', () => {
    const reserved = [
      [{ acceptDownloads: false }, /acceptDownloads.*waitForDownload/],
      [{ httpCredentials: { username: 'ada', password: 'x' } }, /httpCredentials.*basicAuth/],
      [{ recordVideo: { dir: '/tmp' } }, /recordVideo.*--video/],
    ] as const;
    for (const [context, message] of reserved) {
      expect(() => web({ context: context as unknown as WebContextOptions })).toThrowError(message);
    }
  });

  it('refuses a context that is not a plain object', () => {
    for (const context of [null, [], 'locale=de', 3]) {
      expect(() => web({ context: context as unknown as WebContextOptions })).toThrowError(
        /must be an object/,
      );
    }
  });

  it('treats context.viewport as the viewport option: one setting, no null, positive dimensions', () => {
    expect(() =>
      web({ viewport: { width: 390, height: 664 }, context: { viewport: { width: 390, height: 664 } } }),
    ).not.toThrow();
    expect(() =>
      web({ viewport: { width: 1280, height: 720 }, context: { viewport: { width: 390, height: 664 } } }),
    ).toThrowError(/one setting and disagree/);
    expect(() =>
      web({ context: { viewport: null } as unknown as WebContextOptions }),
    ).toThrowError(/viewport to null/);
    expect(() => web({ context: { viewport: { width: 0, height: 664 } } })).toThrowError(/positive dimensions/);
  });

  it('refuses allowing service workers next to headers, which depend on the block', () => {
    expect(() =>
      web({ headers: { 'x-bypass': '1' }, context: { serviceWorkers: 'allow' } }),
    ).toThrowError(/service workers together with headers/);
    expect(() => web({ headers: { 'x-bypass': '1' }, context: { serviceWorkers: 'block' } })).not.toThrow();
    expect(() => web({ context: { serviceWorkers: 'allow' } })).not.toThrow();
  });

  it('is unavailable with a persistent recovery context, as headers and basicAuth are', () => {
    expect(() =>
      web({ connect: { ...cdp, reconnectEndpoint: () => 'ws://localhost:9222' }, context: { locale: 'de' } }),
    ).toThrowError(/persistent context.*context require a newly created context/);
    expect(() => web({ connect: cdp, context: { locale: 'de' } })).not.toThrow();
  });
});

describe('web({ launch })', () => {
  it('accepts Playwright launch options', () => {
    expect(() =>
      web({
        launch: {
          channel: 'chrome',
          args: ['--disable-gpu'],
          proxy: { server: 'http://proxy:3128' },
          slowMo: 50,
          timeout: 90_000,
          env: { TZ: 'UTC' },
        },
      }),
    ).not.toThrow();
    expect(() => web({ launch: {} })).not.toThrow();
  });

  it('refuses headless, which the --headed flag owns', () => {
    expect(() =>
      web({ launch: { headless: false } as unknown as WebLaunchOptions }),
    ).toThrowError(/headless.*--headed/);
  });

  it('refuses a launch that is not a plain object', () => {
    for (const launch of [null, [], 'chrome', 3]) {
      expect(() => web({ launch: launch as unknown as WebLaunchOptions })).toThrowError(
        /must be an object/,
      );
    }
  });

  it('refuses a release channel on a browser other than chromium', () => {
    expect(() => web({ browser: 'firefox', launch: { channel: 'chrome' } })).toThrowError(
      /channel.*requires the chromium browser.*"firefox"/,
    );
    expect(() => web({ browser: 'chromium', launch: { channel: 'chrome' } })).not.toThrow();
    expect(() => web({ browser: 'firefox', launch: { args: ['-headless'] } })).not.toThrow();
  });

  it('is unavailable with connect, which launches nothing', () => {
    expect(() => web({ connect: cdp, launch: { slowMo: 1 } })).toThrowError(
      /launch.*connect attaches to one launched elsewhere/,
    );
  });
});

describe('resolveViewport', () => {
  const fallback = { width: 1280, height: 720 };

  it('prefers the engine option, then the context viewport, then the default', () => {
    expect(resolveViewport({ width: 1, height: 2 }, { viewport: { width: 3, height: 4 } }, fallback)).toEqual({
      width: 1,
      height: 2,
    });
    expect(resolveViewport(undefined, { viewport: { width: 3, height: 4 } }, fallback)).toEqual({ width: 3, height: 4 });
    expect(resolveViewport(undefined, { locale: 'de' }, fallback)).toBe(fallback);
    expect(resolveViewport(undefined, undefined, fallback)).toBe(fallback);
  });
});

describe('bringsOwnExecutable', () => {
  it('is true for an executable path or a non-chromium channel, which the managed install never serves', () => {
    expect(bringsOwnExecutable(undefined)).toBe(false);
    expect(bringsOwnExecutable({ args: [] })).toBe(false);
    expect(bringsOwnExecutable({ executablePath: '/opt/chrome' })).toBe(true);
    expect(bringsOwnExecutable({ channel: 'chrome' })).toBe(true);
    expect(bringsOwnExecutable({ channel: 'msedge' })).toBe(true);
    expect(bringsOwnExecutable({ channel: 'chromium' })).toBe(false);
  });
});
