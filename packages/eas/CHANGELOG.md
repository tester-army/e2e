# @e2e-dev/eas

## 0.1.0

### Minor Changes

- [#671](https://github.com/tester-army/e2e/pull/671) [`86fb6ea`](https://github.com/tester-army/e2e/commit/86fb6eae1f557d99451d54dbf598ed7d4a6aeead) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `@e2e-dev/eas`: `mobile({ device: easSimulators({ projectId }) })` runs a mobile target on EAS Simulators, one hosted iOS simulator or Android emulator per worker slot, driven through the agent-device daemon EAS runs beside it. `buildId` or `applicationArchiveUrl` has EAS install the app, or `device.installApp()` uploads the target's `app.appPath` through the daemon. It reads `EXPO_TOKEN` from the run's environment, names each session after its target and slot and tags it `e2e`, `e2e-run:<run id>`, and `e2e-target:<target>`, defaults `maxIdleTimeMinutes` to 10 so EAS stops a session a dead run never released, logs each session's expo.dev page, starts each daemon at the agent-device version `@e2e-dev/mobile` pins, stops a session that fails, is cancelled, stays queued while another session of the run idles to the limit, or boots for 15 minutes, and cancels the queued job of a session it stops. It calls Expo's API with `fetch`; `@e2e-dev/mobile` is its peer.

### Patch Changes

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `easSimulators()` rejects an option it does not take with `INVALID_CONFIG`, naming the nearest known option when it is a likely typo (`buildID` for `buildId`) and every option otherwise; before, a misspelled option was dropped and EAS started a session without it. Its refusals of `buildId` and `applicationArchiveUrl` passed together, and of a `maxIdleTimeMinutes` not below a `maxDurationMinutes` passed with it, are `INVALID_CONFIG` too instead of `CONFIG_LOAD_FAILED`. `e2e` is now a peer.
