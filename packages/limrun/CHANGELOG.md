# @e2e-dev/limrun

## 0.2.4

### Patch Changes

- [#1516](https://github.com/tester-army/e2e/pull/1516) [`0410fc9`](https://github.com/tester-army/e2e/commit/0410fc9c74ffac45d5174b7a3a5b3e6f15fdf32f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.36, @agentclientprotocol/sdk to 2.4.0, @vitest/expect to 5.1.0, and oxc to 0.157.0.

- [#1576](https://github.com/tester-army/e2e/pull/1576) [`33a1541`](https://github.com/tester-army/e2e/commit/33a154157975bb38a421a912052e4d0e436067c8) Thanks [@kdy1](https://github.com/kdy1)! - Start faster by loading heavy dependencies when a command or session needs them. The CLI no longer loads the MCP server, the prompt library, or the schema library until `mcp`, `init`, `login`, `logout`, `models`, `explore`, `upgrade`, `doctor`, or `--watch` runs, so `e2e --version` and `--help` take about 25% less time. `@e2e-dev/web` imports Playwright when a browser is first launched or looked up, so a process that only reads the config skips it: `e2e list` on a web project takes about 44% less time, and importing the package half as long. A worker loads Playwright for its first browser instead of before its first test, so that test's reported duration grows by about 0.14 s while the run takes no longer. `e2e/runner` no longer loads the explorer when imported. `@e2e-dev/acp` loads the ACP and MCP SDKs when its first session starts, and `@e2e-dev/limrun` loads `@limrun/api` when its first device is leased.

- [#1513](https://github.com/tester-army/e2e/pull/1513) [`383c0bc`](https://github.com/tester-army/e2e/commit/383c0bca467c3cc4d55b02eec07919efa8a99012) Thanks [@thymikee](https://github.com/thymikee)! - Device-cloud leases are allocated and renewed under a named agent-device session, so a newer agent-device that refuses a provider lease to an unnamed client keeps working with BrowserStack, TestMu AI, and Limrun.

## 0.2.3

### Patch Changes

- [#1420](https://github.com/tester-army/e2e/pull/1420) [`512eed7`](https://github.com/tester-army/e2e/commit/512eed789dd1234011c5997b680ab1b90e3f8772) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.33.

- [#1458](https://github.com/tester-army/e2e/pull/1458) [`450be72`](https://github.com/tester-army/e2e/commit/450be721e46a0bc024d873db85b5a7a6c3692965) Thanks [@kacperkapusciak](https://github.com/kacperkapusciak)! - Update agent-device and @agent-device/testmu to 0.21.35. An unscoped boot picks the newest of several shut-down devices, and on iOS, pressing return with nothing focused keeps the runner session.

- [#1382](https://github.com/tester-army/e2e/pull/1382) [`3a8d6f1`](https://github.com/tester-army/e2e/commit/3a8d6f1b6cdaa4c7975c55bf25f67d2e76143b21) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.31, zod to 4.6.7, @modelcontextprotocol/server to 2.4.0, and oxc to 0.155.0.

- [#1449](https://github.com/tester-army/e2e/pull/1449) [`abb10cf`](https://github.com/tester-army/e2e/commit/abb10cfe154cd979ccec7747b2c799b4929d4c30) Thanks [@bheemreddy-samsara](https://github.com/bheemreddy-samsara)! - Update agent-device to 0.21.34. Hosted WebDriver fills replace the confirmed focused field instead of appending, and an unsupported active-element lookup refuses before tapping. The pre-tap focus probe no longer reads the previous field's geometry.

## 0.2.2

### Patch Changes

- [#1308](https://github.com/tester-army/e2e/pull/1308) [`07eb481`](https://github.com/tester-army/e2e/commit/07eb4812ffd7226d5a5a1ee1a6ab23076f138f0f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.29.

## 0.2.1

### Patch Changes

- [#1181](https://github.com/tester-army/e2e/pull/1181) [`fc5c350`](https://github.com/tester-army/e2e/commit/fc5c350d490f40417fb71040c0344733d5596c70) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Bump agent-device to 0.21.28.

- [#1190](https://github.com/tester-army/e2e/pull/1190) [`e4d16ec`](https://github.com/tester-army/e2e/commit/e4d16eceebc18911ca04542393c1581dc451208c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - EAS Simulators fails with `EAS: unexpected response to <operation>` when Expo's API answers without the fields a session needs, instead of a `TypeError`, and a daemon address answered as `null` reads as not ready yet. Limrun names the installed agent-device `package.json` when it declares no version or no `agent-device` bin, instead of reporting version `undefined` or not finding the CLI.

## 0.2.0

### Minor Changes

- [#988](https://github.com/tester-army/e2e/pull/988) [`c807f94`](https://github.com/tester-army/e2e/commit/c807f9480646a13f00d308cdd0a90034908b5543) Thanks [@enesonus](https://github.com/enesonus)! - Add the Limrun device provider with one hosted instance per worker, app
  installation, recording through agent-device, and cleanup on run exit.
  Renew retained driver leases while other targets run. Keep provider-owned
  local daemons isolated from ambient remote-daemon environment settings.

### Patch Changes

- [#1066](https://github.com/tester-army/e2e/pull/1066) [`c4263bd`](https://github.com/tester-army/e2e/commit/c4263bde1786fdf19817eb53441e5460e682f012) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Ship agent-device as a regular dependency pinned to the mobile engine's version instead of an exact peer dependency, so users no longer install it by hand.
