---
"@e2e-dev/mobile": patch
---

On a simulator or emulator, an attempt that records video no longer fails to start when no app is open in the session: after a test's `closeApp()`, or before a fixture installs the build. The engine records the whole device screen (agent-device's `device` scope) instead of the app session, which refused to start without an open app. A recording that started without a session ends the session agent-device made for it when it stops, and the engine now treats that as a closed session, as after `closeApp()`. A physical iOS device still needs an open app to record.
