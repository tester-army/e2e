/** Compile-time assertions for the context and launch pass-through: the engine-owned keys are not in the types. */
import type { WebContextOptions, WebLaunchOptions, WebOptions } from '../../src/index.ts';

({
  locale: 'de-DE',
  timezoneId: 'Europe/Warsaw',
  colorScheme: 'dark',
  ignoreHTTPSErrors: true,
  isMobile: true,
  hasTouch: true,
  viewport: { width: 390, height: 664 },
}) satisfies WebContextOptions;

({ channel: 'chrome', args: ['--disable-gpu'], executablePath: '/opt/chrome', timeout: 90_000 }) satisfies WebLaunchOptions;

// @ts-expect-error downloads are the engine's; it turns them on itself.
({ acceptDownloads: true }) satisfies WebContextOptions;
// @ts-expect-error basic auth goes through web({ basicAuth }).
({ httpCredentials: { username: 'ada', password: 'x' } }) satisfies WebContextOptions;
// @ts-expect-error recordings go through e2e run --video.
({ recordVideo: { dir: '/tmp' } }) satisfies WebContextOptions;
// @ts-expect-error a fixed viewport is required; null is Playwright's "window size".
({ viewport: null }) satisfies WebContextOptions;
// @ts-expect-error headed or headless is the run's --headed flag.
({ headless: false }) satisfies WebLaunchOptions;

({ context: { locale: 'de' }, launch: { channel: 'chrome' } }) satisfies WebOptions;
