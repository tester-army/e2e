---
"@e2e-dev/mobile": patch
---

Permissions are set on the app by name, with agent-device's `settings permission --app` (0.21.21). `device.setPermission()` and the permissions a launch presets no longer open the app first to put agent-device's session on it, so a permission goes in before the app's first launch with no foreground open. `device.setPermission()` always acts on the pinned app, as documented, not on whichever app the session last opened. The warm-up in `prepare` still opens the pinned app, and a worker no longer lists agent-device's sessions at start.
