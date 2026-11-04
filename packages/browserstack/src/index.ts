/**
 * `@e2e-dev/browserstack` public surface: `browserstack()`, a device provider
 * that leases BrowserStack App Automate real Android and iOS devices for
 * `@e2e-dev/mobile` through agent-device's built-in BrowserStack provider.
 */

export { browserstack } from './provider.ts';
export type { BrowserStackOptions } from './provider.ts';
