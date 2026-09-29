---
"@e2e-dev/mobile": patch
---

An attempt that records video no longer fails to start when no app is open in the session: after a test's `closeApp()`, or before a fixture installs the build. The engine records the whole device screen (agent-device's `device` scope) instead of the app session, which refused to start without an open app.
