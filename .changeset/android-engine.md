---
'@e2e-dev/android': patch
---

Add `@e2e-dev/android`, an experimental Android engine: `android()` runs a native engine server on the device as an instrumentation and drives it through `UiAutomation` over the engine protocol, with no agent-device. It runs the deterministic suite of the mobile benchmark about twice as fast as `mobile()` on an emulator. One device per run, and the `device` fixture has only `back()`.
