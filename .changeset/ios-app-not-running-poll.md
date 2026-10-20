---
'@e2e-dev/mobile': patch
---

Locators and `expect` now keep waiting while iOS reports the app as not running, as on a physical iPhone right after `app.restart()`, instead of failing at once with `ENGINE_FAILURE`. A wait that runs out while the app is still down fails with that reason.
