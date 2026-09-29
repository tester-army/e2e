---
"@e2e-dev/eas": minor
---

`@e2e-dev/eas`: `mobile({ device: easSimulators({ projectId }) })` runs a mobile target on EAS Simulators, one hosted iOS simulator or Android emulator per worker slot, driven through the agent-device daemon EAS runs beside it. `buildId` or `applicationArchiveUrl` has EAS install the app, or `device.installApp()` uploads a local build through the daemon. It reads `EXPO_TOKEN` from the run's environment, names and tags every session with the run, target, and slot, defaults `maxIdleTimeMinutes` to 10 so EAS stops a session a dead run never released, logs each session's expo.dev page, stops a session that fails, is cancelled, queues past the idle limit beside other slots, or boots for 15 minutes, and cancels the queued job of a session it stops. It calls Expo's API with `fetch`; `@e2e-dev/mobile` is its peer.
