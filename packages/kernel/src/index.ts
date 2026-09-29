/**
 * `@e2e-dev/kernel` public surface: `kernel()`, a browser provider that leases
 * hosted Chromium from Kernel for `@e2e-dev/web`.
 */

export { kernel } from './provider.ts';
export type { KernelOptions } from './provider.ts';
export type { KernelBrowserParams, KernelReplayParams } from './client.ts';
