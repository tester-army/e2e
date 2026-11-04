---
'@e2e-dev/mobile': patch
---

Snapshots and screenshots now run within the timeout of the call that takes them (an action's `timeout`, an `expect` timeout), so a device that stops answering fails the step instead of holding it until the test timeout. Requires `e2e` 0.22.0 or later.
