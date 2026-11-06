---
"@e2e-dev/mobile": patch
---

`device.installApp` and `device.openApp` no longer drop launch arguments without a word. `installApp` fails with `INVALID_ARGUMENT` on a launch option (`launchArguments`, `relaunch`, `permissions`) and names where it goes: the target's `app.launchArguments`, which `app.open()` passes, or `device.openApp(app, { relaunch: true, launchArguments })`. `openApp` fails on an unknown option such as Detox's `launchArgs`, on `launchArguments` that is not a list of strings, and on `launchArguments` without `relaunch: true`, which left a running app with the arguments it started with.
