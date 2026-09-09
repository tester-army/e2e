---
'@e2edev/e2e': minor
---

`EngineInitInfo.workerSlot`: the 0-based slot of the worker among its target's workers, the lowest one free when the worker was spawned. An engine with several devices can hand each slot its own, so `workers: n` on a device target splits the suite across `n` devices instead of sharing one.
