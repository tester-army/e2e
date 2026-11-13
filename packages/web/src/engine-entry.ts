/**
 * `@e2e-dev/web/engine`: the `web()` factory and its types, without `test`,
 * so a program that drives a browser with `e2e-core` never loads the test
 * runner. The main entry re-exports all of it beside `test`.
 */

export { web, surfaceOf } from './engine.ts';
/** The engine factory again, as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { web as default } from './engine.ts';
export type { PlaywrightLiveSurface } from './engine.ts';
export type { WebBasicAuth, WebConnectOptions, WebOptions, WebScreencastOptions } from './surface.ts';
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
export type { BrowserName, CdpTarget } from './browser-connection.ts';
export type { Dialog, DialogHandler } from './dialogs.ts';
export type {
  Browser,
  BrowserExpectation,
  BrowserTab,
  Cookie,
  CookieFields,
  CookieFilter,
  FrameScreen,
  RouteContinueOverrides,
  RouteFulfillResponse,
  WebResponse,
  WebRoute,
} from './browser.ts';

export type { WebApp, WebFixtures } from './fixtures.ts';

