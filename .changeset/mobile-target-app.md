---
'@e2e-dev/mobile': minor
---

Breaking: `mobile()` only drives the device. The app it launches is the target's: `mobile({ app })` becomes `targets: [{ engine: mobile({ platform }), app: { bundleId } }]`, and `appPath`, `launchArguments`, `permissions`, `identity`, and `environment` move under the target's `app` too; every old option fails in one `INVALID_CONFIG` naming its new place. A device target needs `app.bundleId` or `app.appPath`, so `app.open()`, `app.restart()`, and `app.clearState()` are always there. `app.url` on a device target is refused as not supported yet, with a note on reaching this machine from an iOS simulator or an Android emulator. A device target is a `native-app` target, so a test can require one with `requires: ['native-app']`.
