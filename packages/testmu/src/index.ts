/**
 * `@e2e-dev/testmu` public surface: `testmu()`, a device provider that leases
 * TestMu AI (formerly LambdaTest) Android emulators, iOS simulators, and real
 * devices for `@e2e-dev/mobile` through agent-device's `testmu` provider.
 * `testmuBrowsers()`, for TestMu AI's hosted Chrome and Edge on `@e2e-dev/web`,
 * is exported from `@e2e-dev/testmu/web`.
 */

export { testmu } from './provider.ts';
export type { TestmuOptions } from './provider.ts';
