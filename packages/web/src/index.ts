/**
 * `@e2e-dev/web` public surface: the `web()` engine factory, the `browser`
 * fixture types, and `test`, `describe`, and the hooks typed with that
 * fixture, so a test file registers from one import. `expect`,
 * `credentials`, and `secrets` come from `e2e` itself.
 */

import { test as base } from 'e2e';
import type { Browser } from './browser.ts';

export { web, surfaceOf } from './engine.ts';
export type { PlaywrightLiveSurface } from './engine.ts';
export type { WebBasicAuth, WebConnectOptions, WebOptions, WebScreencastOptions } from './surface.ts';
export type { WebInitScript } from './init-scripts.ts';
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
  RouteContinueOverrides,
  RouteFulfillResponse,
  WebResponse,
  WebRoute,
} from './browser.ts';

/**
 * `test` typed with this engine's contributed `browser` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ browser: Browser }>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `browser` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
