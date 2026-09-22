---
'@e2edev/mobile': patch
---

The `EngineAttemptContext` the engine receives in `startAttempt` now carries `registerSecret`, the harness's way for an engine to hand a value it puts on the wire to the redactor; the mobile engine registers nothing through it yet.
