/**
 * `@e2edev/playwright` public surface: the `playwright()` backend factory, the
 * `web` fixture types, and a `test` typed with that fixture. Everything else a
 * test needs (`expect`, `credentials`) comes from `e2e` itself: this package
 * contributes a surface, it does not re-export the test API.
 */

import { test as base } from 'e2e';
import type { Web } from './web.ts';

export { playwright } from './backend.ts';
export type { PlaywrightOptions } from './surface.ts';
export type { BrowserName } from './browser-pool.ts';
export type { Dialog } from './dialogs.ts';
export type {
  Cookie,
  CookieFields,
  RouteFulfillResponse,
  Web,
  WebExpectation,
  WebResponse,
  WebRoute,
} from './web.ts';

/**
 * `test` typed with this backend's contributed `web` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ web: Web }>();
