/**
 * `@e2e-dev/revyl` public surface: `revyl()`, a device provider that leases
 * Revyl hosted iOS simulators and Android emulators for `@e2e-dev/mobile`
 * through agent-device's `@agent-device/revyl` plugin.
 */

export { revyl } from './provider.ts';
export type { RevylOptions } from './provider.ts';
