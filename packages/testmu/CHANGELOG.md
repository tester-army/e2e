# @e2e-dev/testmu

## 0.0.3

### Patch Changes

- [#1420](https://github.com/tester-army/e2e/pull/1420) [`512eed7`](https://github.com/tester-army/e2e/commit/512eed789dd1234011c5997b680ab1b90e3f8772) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.33.

- [#1458](https://github.com/tester-army/e2e/pull/1458) [`450be72`](https://github.com/tester-army/e2e/commit/450be721e46a0bc024d873db85b5a7a6c3692965) Thanks [@kacperkapusciak](https://github.com/kacperkapusciak)! - Update agent-device and @agent-device/testmu to 0.21.35. An unscoped boot picks the newest of several shut-down devices, and on iOS, pressing return with nothing focused keeps the runner session.

- [#1382](https://github.com/tester-army/e2e/pull/1382) [`3a8d6f1`](https://github.com/tester-army/e2e/commit/3a8d6f1b6cdaa4c7975c55bf25f67d2e76143b21) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.31, zod to 4.6.7, @modelcontextprotocol/server to 2.4.0, and oxc to 0.155.0.

- [#1449](https://github.com/tester-army/e2e/pull/1449) [`abb10cf`](https://github.com/tester-army/e2e/commit/abb10cfe154cd979ccec7747b2c799b4929d4c30) Thanks [@bheemreddy-samsara](https://github.com/bheemreddy-samsara)! - Update agent-device to 0.21.34. Hosted WebDriver fills replace the confirmed focused field instead of appending, and an unsupported active-element lookup refuses before tapping. The pre-tap focus probe no longer reads the previous field's geometry.

- [#1307](https://github.com/tester-army/e2e/pull/1307) [`64432f1`](https://github.com/tester-army/e2e/commit/64432f10891d9772494137b0ba328d8ef440deae) Thanks [@malopezr7](https://github.com/malopezr7)! - A device release now fails the run when agent-device can't confirm it ended the TestMu AI session: a forced daemon stop, a lost shutdown report, or a daemon that exited during the run. Needs `@e2e-dev/mobile` 0.12.5 or later.

## 0.0.2

### Patch Changes

- [#1308](https://github.com/tester-army/e2e/pull/1308) [`07eb481`](https://github.com/tester-army/e2e/commit/07eb4812ffd7226d5a5a1ee1a6ab23076f138f0f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.29.

- [#1209](https://github.com/tester-army/e2e/pull/1209) [`ef977f4`](https://github.com/tester-army/e2e/commit/ef977f4856da009cac26d78d2e9bb14e5991ee41) Thanks [@knowbody](https://github.com/knowbody)! - Clarify the allocation error when agent-device does not acknowledge `retainOnClose`. The message explains that closing the engine session could end the TestMu AI lease before the provider releases it.

- [#1200](https://github.com/tester-army/e2e/pull/1200) [`92f8cb0`](https://github.com/tester-army/e2e/commit/92f8cb07bf1b997e144aaa56d421e3d57729ef6b) Thanks [@amankansal-lt](https://github.com/amankansal-lt)! - `testmuBrowsers()` from `@e2e-dev/testmu/web` runs web targets in TestMu AI (formerly LambdaTest) hosted Chrome or Edge, one session per worker slot: `web({ browser: testmuBrowsers() })`. `@e2e-dev/mobile` and `@e2e-dev/web` are optional peers now, so a project installs only the engine it uses.

## 0.0.1

### Patch Changes

- [#772](https://github.com/tester-army/e2e/pull/772) [`88ed717`](https://github.com/tester-army/e2e/commit/88ed71768aa7577e473a2df52ff418d35f5cfe8f) Thanks [@amankansal-lt](https://github.com/amankansal-lt)! - New `@e2e-dev/testmu` package: `mobile({ device: testmu({ device, osVersion, app }) })` runs a mobile target on TestMu AI (formerly LambdaTest) Android emulators, iOS simulators, and real devices, one per worker slot, with `LT_USERNAME` and `LT_ACCESS_KEY` from the run's environment. An attempt that records video links TestMu AI's recording of its session.
