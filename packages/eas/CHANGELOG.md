# @e2e-dev/eas

## 0.2.0

### Minor Changes

- [#730](https://github.com/tester-army/e2e/pull/730) [`1554360`](https://github.com/tester-army/e2e/commit/1554360ba2b3d3aff5efeff443b16d8985a169ca) Thanks [@szdziedzic](https://github.com/szdziedzic)! - `easSimulators()` authenticates with the eas-cli login when `EXPO_TOKEN` is not set: it reads the session `eas login` keeps in `~/.expo/state.json` (under `USERPROFILE` on Windows) and sends it in the `expo-session` header, as eas-cli does, so a machine signed in to eas-cli needs no token. `EXPO_TOKEN` still wins when both are there. A session is stopped as the account that started it, even if the login changes during the run. Only the production login is read, since the sessions API is `api.expo.dev`. With neither a token nor a login, the lease fails with `EXPO_TOKEN is not set and eas-cli is not logged in`.

- [#731](https://github.com/tester-army/e2e/pull/731) [`88cef2c`](https://github.com/tester-army/e2e/commit/88cef2c26d0b095ce490e9f86c09221ce28d8fa9) Thanks [@szdziedzic](https://github.com/szdziedzic)! - `easSimulators()` takes `projectId` from the app config when the option is absent: `extra.eas.projectId`, the id `eas init` writes, read from `app.config.json` or `app.json` beside `e2e.config.ts`, or from a dynamic `app.config.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) as the project's own `expo config --type public` evaluates it in the run's environment, without `.env` files, as eas-cli runs it. It reads the config once per run, before the first session starts; a config that links no project fails the lease naming the file. `projectId` is optional now and still wins when it is passed. Reading it needs the `@e2e-dev/mobile` that passes `projectRoot` to device providers.

## 0.1.1

### Patch Changes

- [#706](https://github.com/tester-army/e2e/pull/706) [`1a80c23`](https://github.com/tester-army/e2e/commit/1a80c23d8789382847aa78fb5325ecc1281c3b6a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - npm package pages: `e2e` ships the repository README, and every package has keywords people search for.

## 0.1.0

### Minor Changes

- [#671](https://github.com/tester-army/e2e/pull/671) [`86fb6ea`](https://github.com/tester-army/e2e/commit/86fb6eae1f557d99451d54dbf598ed7d4a6aeead) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `@e2e-dev/eas`: `mobile({ device: easSimulators({ projectId }) })` runs a mobile target on EAS Simulators, one hosted iOS simulator or Android emulator per worker slot, driven through the agent-device daemon EAS runs beside it. `buildId` or `applicationArchiveUrl` has EAS install the app, or `device.installApp()` uploads the target's `app.appPath` through the daemon. It reads `EXPO_TOKEN` from the run's environment, names each session after its target and slot and tags it `e2e`, `e2e-run:<run id>`, and `e2e-target:<target>`, defaults `maxIdleTimeMinutes` to 10 so EAS stops a session a dead run never released, logs each session's expo.dev page, starts each daemon at the agent-device version `@e2e-dev/mobile` pins, stops a session that fails, is cancelled, stays queued while another session of the run idles to the limit, or boots for 15 minutes, and cancels the queued job of a session it stops. It calls Expo's API with `fetch`; `@e2e-dev/mobile` is its peer.

### Patch Changes

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `easSimulators()` rejects an option it does not take with `INVALID_CONFIG`, naming the nearest known option when it is a likely typo (`buildID` for `buildId`) and every option otherwise; before, a misspelled option was dropped and EAS started a session without it. Its refusals of `buildId` and `applicationArchiveUrl` passed together, and of a `maxIdleTimeMinutes` not below a `maxDurationMinutes` passed with it, are `INVALID_CONFIG` too instead of `CONFIG_LOAD_FAILED`. `e2e` is now a peer.
