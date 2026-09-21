/**
 * `@e2edev/web` public surface: the `web()` engine factory, the
 * `web` fixture types, and a `test` typed with that fixture. Everything else a
 * test needs (`expect`, `credentials`) comes from `e2e` itself: this package
 * contributes a surface, it does not re-export the test API.
 */

import { test as base } from 'e2e';
import type { Web } from './web.ts';

export { web, surfaceOf } from './engine.ts';
export type { PlaywrightLiveSurface } from './engine.ts';
export type { WebBasicAuth, WebConnectOptions, WebOptions } from './surface.ts';
export type { BrowserName } from './browser-connection.ts';
export type { Cookie, CookieFields, WebCookie } from './cookies.ts';
export type { Dialog, DialogHandler } from './dialogs.ts';
export type {
  FrameScreen,
  RouteFulfillResponse,
  Web,
  WebExpectation,
  WebResponse,
  WebRoute,
} from './web.ts';

/**
 * `test` typed with this engine's contributed `web` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ web: Web }>();
