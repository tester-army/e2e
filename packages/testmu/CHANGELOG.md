# @e2e-dev/testmu

## 0.0.2

### Patch Changes

- [#1308](https://github.com/tester-army/e2e/pull/1308) [`07eb481`](https://github.com/tester-army/e2e/commit/07eb4812ffd7226d5a5a1ee1a6ab23076f138f0f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.29.

- [#1209](https://github.com/tester-army/e2e/pull/1209) [`ef977f4`](https://github.com/tester-army/e2e/commit/ef977f4856da009cac26d78d2e9bb14e5991ee41) Thanks [@knowbody](https://github.com/knowbody)! - Clarify the allocation error when agent-device does not acknowledge `retainOnClose`. The message explains that closing the engine session could end the TestMu AI lease before the provider releases it.

- [#1200](https://github.com/tester-army/e2e/pull/1200) [`92f8cb0`](https://github.com/tester-army/e2e/commit/92f8cb07bf1b997e144aaa56d421e3d57729ef6b) Thanks [@amankansal-lt](https://github.com/amankansal-lt)! - `testmuBrowsers()` from `@e2e-dev/testmu/web` runs web targets in TestMu AI (formerly LambdaTest) hosted Chrome or Edge, one session per worker slot: `web({ browser: testmuBrowsers() })`. `@e2e-dev/mobile` and `@e2e-dev/web` are optional peers now, so a project installs only the engine it uses.

## 0.0.1

### Patch Changes

- [#772](https://github.com/tester-army/e2e/pull/772) [`88ed717`](https://github.com/tester-army/e2e/commit/88ed71768aa7577e473a2df52ff418d35f5cfe8f) Thanks [@amankansal-lt](https://github.com/amankansal-lt)! - New `@e2e-dev/testmu` package: `mobile({ device: testmu({ device, osVersion, app }) })` runs a mobile target on TestMu AI (formerly LambdaTest) Android emulators, iOS simulators, and real devices, one per worker slot, with `LT_USERNAME` and `LT_ACCESS_KEY` from the run's environment. An attempt that records video links TestMu AI's recording of its session.
