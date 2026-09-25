---
'@e2edev/mobile': minor
---

`launchArguments` and `permissions` on the engine ride every fresh launch of the pinned app (`app.open()`, `app.restart()`, `app.clearState()`): the arguments reach the app process on iOS and `am start` on Android, and each permission is granted, denied, or reset before the app starts, since a change terminates a running app; `app.clearState()` puts them back after it reset them with the data. `device.openApp(app, { launchArguments, permissions })` does the same for one launch of any app. `device.clearKeychain()` resets the iOS simulator's keychain, which `app.clearState()` leaves alone; Android is `UNSUPPORTED_CAPABILITY`. Maestro's `launchApp: { arguments, permissions }` and `clearKeychain`, Detox's `launchArgs` and `permissions`.
