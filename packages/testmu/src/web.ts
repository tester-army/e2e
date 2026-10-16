/**
 * `@e2e-dev/testmu/web`: `testmuBrowsers()`, for web targets. It loads neither
 * `@e2e-dev/mobile` nor agent-device, and the package root, which exports the
 * device provider, does not reference `@e2e-dev/web`.
 */

export { testmuBrowsers } from './browsers.ts';
export type { TestmuBrowserName, TestmuBrowsersOptions, TestmuBrowsersRoute } from './browsers.ts';
