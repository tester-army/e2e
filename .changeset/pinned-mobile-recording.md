---
"@e2e-dev/mobile": patch
---

Forward the worker's device selection with video recording, app state resets, device settings, alerts (including the agent's `alert` tool), and clipboard requests. Commands that run without an open app stay on the selected device after `device.closeApp()` ends the session, even when several simulators or emulators are booted.
