---
'@e2e-dev/mobile': patch
---

Locators and `expect` now keep waiting while iOS reports the app as not running just after `app.open()`, `app.restart()`, or `device.openLink()` launches it, as on a physical iPhone, instead of failing at once with `ENGINE_FAILURE`. A wait that runs out while the app is still down fails with that reason. An app that exits after its first readable screen still fails at once.
