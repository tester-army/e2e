---
'@e2edev/e2e': minor
---

Worker slots and engine capacity. `EngineInitInfo.workerSlot` is the 0-based slot of the worker among its target's workers, the lowest one free when it was spawned, so an engine with several devices hands each slot its own. An engine declares `workers`, the most it serves per target at once; the scheduler never starts more for that target, whatever `config.workers` allows, so a device target shares a run with browser targets without being over-subscribed. `EnginePrepareInfo.workers` tells `prepare` how many slots the run will use.
