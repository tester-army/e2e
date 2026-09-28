/**
 * `@e2e-dev/integrations/kernel` public surface: `kernel()`, a browser
 * provider that leases hosted Chromium from Kernel for `@e2e-dev/web`. Only
 * this subpath imports `@onkernel/sdk`, so the other integrations never need
 * it installed.
 */

export { kernel } from './provider.ts';
export type { KernelOptions } from './provider.ts';
export type { KernelBrowserParams } from './client.ts';
