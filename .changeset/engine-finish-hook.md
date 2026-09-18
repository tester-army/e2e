---
'e2e': minor
---

The engine contract gains an optional `finish(info)` hook: once per run and target in the runner process, after the last worker of the target is gone, on every exit path (pass, failure, interrupt, a `prepare` that threw part-way), within the cleanup budget. Release what `prepare` acquired for the run there. `EnginePrepareInfo` carries `projectRoot`, so a hook can resolve a relative option before any worker exists. Additive; the SPI version stays 1.
