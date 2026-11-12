---
"@e2e-dev/mobile": patch
---

Fix `ENGINE_FAILURE (launch) boot failed: N devices match this request equally` when a target names no `device` and no simulator or emulator is booted. The engine now asks agent-device to boot a shut-down one: newest OS first, then name order.
