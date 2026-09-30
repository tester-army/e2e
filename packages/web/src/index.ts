/**
 * `@e2e-dev/web` public surface: the `web()` engine factory, the
 * `browser` fixture types, and a `test` (with its per-test hooks) typed with
 * that fixture. Everything else a test needs (`expect`, `credentials`) comes from `e2e` itself: this package
 * contributes a surface, it does not re-export the test API.
 */

import { test as base } from 'e2e';
import type { Browser } from './browser.ts';

export { web, surfaceOf } from './engine.ts';
export type { PlaywrightLiveSurface } from './engine.ts';
export type { WebBasicAuth, WebConnectOptions, WebOptions, WebScreencastOptions } from './surface.ts';
export type {
  BrowserDownloadContext,
  BrowserLease,
  BrowserProvider,
  BrowserProviderDownloads,
  BrowserProviderScope,
  BrowserReleaseContext,
  BrowserRequest,
} from './provider.ts';
export type { BrowserName } from './browser-connection.ts';
export type { Dialog, DialogHandler } from './dialogs.ts';
export type {
  Browser,
  BrowserExpectation,
  Cookie,
  CookieFields,
  FrameScreen,
  RouteFulfillResponse,
  WebResponse,
  WebRoute,
} from './browser.ts';

/**
 * `test` typed with this engine's contributed `browser` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ browser: Browser }>();

/** `beforeEach` and `afterEach` typed with the `browser` fixture, as `test.beforeEach` is. */
export const { beforeEach, afterEach } = test;
