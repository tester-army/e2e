/**
 * `@e2e-dev/testmu/web` public surface: `testmuBrowsers()`, a browser provider
 * for TestMu AI's hosted Chrome and Edge on `@e2e-dev/web`. Its types never
 * reference `@e2e-dev/mobile`, and the package root's never reference
 * `@e2e-dev/web`, so a project installs only the engine it uses.
 */

export { testmuBrowsers } from './browsers.ts';
export type { TestmuBrowserName, TestmuBrowsersOptions } from './browsers.ts';
