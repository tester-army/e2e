---
'@e2edev/agent-device': minor
---

`device` accepts a list. Each worker slot boots and drives its own entry under a slot-suffixed session (`e2e-<target>-<slot>`), so `workers: pool.length` runs a target's files across every simulator or emulator in the pool at once. A slot beyond the pool fails that worker's init with `ENGINE_FAILURE` instead of sharing a device.
