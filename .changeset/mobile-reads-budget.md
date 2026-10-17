---
'@e2e-dev/mobile': patch
---

Snapshots and screenshots now get the step's timeout, so a device that stops answering fails the step instead of holding it until the test timeout. Requires `e2e` 0.21.3 or later.
