---
'e2e': patch
---

Workers no longer die about 1 ms after a stop request when a grace budget built from `timeout` and `cleanupTimeout` is longer than 2^31-1 milliseconds. Ctrl-C now runs `afterEach` and disposes the engine with `timeout` near that limit, and engine disposal at the end of a run or on a second Ctrl-C finishes with `cleanupTimeout` near it.
