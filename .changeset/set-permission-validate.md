---
"@e2e-dev/mobile": patch
---

`device.setPermission` checks the permission name and state before any device command, the way `device.openApp({ permissions })` does. A typo such as `'camra'` or a state such as `'allow'` now fails with `INVALID_ARGUMENT` and names the nearest permission, instead of an `ENGINE_FAILURE` from agent-device.
