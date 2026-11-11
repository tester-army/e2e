/**
 * `@e2e-dev/e2b` public surface: `e2b()`, a device provider that runs each
 * worker slot's Android on an E2B `android-16` sandbox for `@e2e-dev/mobile`.
 * `e2bBrowsers()`, for Chromium in E2B sandboxes on `@e2e-dev/web`, is
 * exported from `@e2e-dev/e2b/web`.
 */

export { e2b } from './provider.ts';
export type { E2BOptions } from './provider.ts';
