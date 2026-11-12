/**
 * `@e2e-dev/e2b/web` public surface: `e2bBrowsers()`, a browser provider for
 * Chromium in E2B sandboxes on `@e2e-dev/web`. Its types never reference
 * `@e2e-dev/mobile`, and the package root's never reference `@e2e-dev/web`,
 * so a project installs only the engine it uses.
 */

export { e2bBrowsers } from './browsers.ts';
export type { E2BBrowsersOptions } from './browsers.ts';
