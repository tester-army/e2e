/**
 * `@e2e-dev/smol` public surface: `smol()`, a browser provider that runs
 * Chromium in smol machines microVMs for `@e2e-dev/web`, branching a warm
 * browser per test attempt by default.
 */

export { smol } from './provider.ts';
export type { SmolApp, SmolOptions } from './provider.ts';
