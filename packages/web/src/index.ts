/**
 * `@e2e-dev/web` public surface: the `web()` engine factory, `attachBrowser`, the `browser`
 * fixture types, and `test`, `describe`, and the hooks typed with that
 * fixture, so a test file registers from one import. `expect`,
 * `credentials`, and `secrets` come from `e2e` itself.
 */

import { test as base, type App } from 'e2e';
import type { Browser } from './fixture/types.ts';

export { web } from './engine.ts';
export { attachBrowser, type AttachBrowserOptions, type AttachedBrowser } from './attach.ts';
export type { WebBasicAuth, WebConnectOptions, WebOptions, WebScreencastOptions } from './options.ts';
export type { WebInitScript } from './init-scripts.ts';
export type { WebMedia } from './media.ts';
export type {
  BrowserDownloadContext,
  BrowserLease,
  BrowserProvider,
  BrowserProviderDownloads,
  BrowserProviderScope,
  BrowserReleaseContext,
  BrowserRequest,
} from './provider.ts';
export type { BrowserName } from './browsers.ts';
export type { Dialog, DialogHandler } from './driver/dialogs.ts';
export type {
  Browser,
  BrowserExpectation,
  Cookie,
  CookieFields,
  CookieFilter,
  FrameScreen,
  RouteContinueOverrides,
  RouteFulfillResponse,
  WebResponse,
  WebRoute,
} from './fixture/types.ts';

/** `app` on a web target. A `web()` target always declares `app.url`, so `baseUrl` is always set. */
export interface WebApp extends App {
  /** The target's `app.url` with the run's port and no trailing slash: `${app.baseUrl}/api/users`. */
  readonly baseUrl: string;
}

/**
 * `test` typed with this engine's contributed `browser` fixture and its
 * `app`. The same runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ browser: Browser; app: WebApp }>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `browser` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
