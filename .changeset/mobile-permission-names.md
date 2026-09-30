---
'@e2e-dev/mobile': patch
'e2e': patch
---

A permission name `@e2e-dev/mobile` does not set, or a state other than `grant`, `deny`, or `reset`, fails before any device command: `mobile({ permissions: { camerra: 'grant' } })` is `INVALID_CONFIG` naming `camera`, and the same map in `device.openApp(app, { permissions })` is `INVALID_ARGUMENT`. Before, the typo reached agent-device on the first launch. `rejectUnknownKeys` in `e2e/engine` takes an optional `code`, `'INVALID_ARGUMENT'` for an object a test passes.
