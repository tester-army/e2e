---
"@e2e-dev/mobile": patch
---

`device.installApp` no longer drops launch options without a word. A `launchArguments`, `launchArgs`, `relaunch`, or `permissions` option fails with `INVALID_ARGUMENT` and names where it goes: the target's `app.launchArguments` or `app.permissions`, which `app.open()` applies, or `device.openApp(app, { relaunch: true, ... })`. Any other unknown option, or a path that is not a string, fails the same way.

`device.openApp` fails on an unknown option (Detox's `launchArgs` names `launchArguments`) and on `launchArguments` that is not a list of strings.

**Deprecated:** `device.openApp(app, { launchArguments })` without `relaunch: true`. A running app keeps the arguments it started with, so the new ones never reach it. The call still sends them, with a `DeprecationWarning` once per worker. Pass `relaunch: true`. A later release will refuse the call.
