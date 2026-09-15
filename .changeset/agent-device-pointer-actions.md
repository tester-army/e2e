---
'@e2edev/agent-device': minor
---

Declares `tap`, `doubleTap`, and `longPress` as pointer actions at a bare screen point (`performAt` with `pointerActions`), replacing `tapAt`. A role query with `pressed` or `level` matches nothing on a device tree that reports neither, rather than everything.
