/**
 * `@e2e-dev/eas` public surface: `easSimulators()`, a device provider that
 * leases hosted simulators from EAS Simulators for `@e2e-dev/mobile`. It
 * talks to Expo's API over `fetch`, so it needs no SDK.
 */

export { easSimulators } from './provider.ts';
export type { EasSimulatorsOptions } from './provider.ts';
