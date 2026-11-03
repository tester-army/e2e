---
"@e2e-dev/eas": patch
---

`easSimulators()` is now `expoSimulators()`, matching the service's name, Expo Simulators. `easSimulators()` and `EasSimulatorsOptions` still work as deprecated aliases of `expoSimulators()` and `ExpoSimulatorsOptions`. The provider now logs as `expo-simulators` instead of `eas-simulators`, and its config errors start with `expoSimulators`.
