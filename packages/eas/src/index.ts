/**
 * `@e2e-dev/eas` public surface: `expoSimulators()`, a device provider that
 * leases hosted simulators from Expo Simulators for `@e2e-dev/mobile`. It
 * talks to Expo's API over `fetch`, so it needs no SDK. `easSimulators()` is
 * its deprecated old name.
 */

export { easSimulators, expoSimulators } from './provider.ts';
export type { EasSimulatorsOptions, ExpoSimulatorsOptions } from './provider.ts';
