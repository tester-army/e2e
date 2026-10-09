---
'@e2e-dev/mobile': minor
---

Breaking: `device.setNetwork('offline')` and `device.setAirplaneMode(true)` now fail with `UNSUPPORTED_CAPABILITY` on iOS. They previously changed only the simulator's status bar while the app stayed online. Restoring the network with `setNetwork('online')` or `setAirplaneMode(false)` does nothing on iOS, so shared cleanup hooks still work.

Run offline tests on Android with `platforms: ['android']` and `setAirplaneMode(true)` (Android 11+). `setNetwork('offline')` turns off Wi-Fi only; cellular data can keep the app online.
