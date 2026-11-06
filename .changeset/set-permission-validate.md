---
"@e2e-dev/mobile": patch
---

`device.setPermission` checks the permission name and state before any device command, the way `device.openApp({ permissions })` does. A bad name or state now fails with `INVALID_ARGUMENT` instead of an `ENGINE_FAILURE` from agent-device: a typo such as `'camra'` names the nearest permission, and a state such as `'allow'`, or none at all, lists the valid states.
