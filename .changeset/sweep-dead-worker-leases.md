---
'@e2e-dev/web': patch
'@e2e-dev/kernel': patch
---

A worker that dies no longer leaks its Kernel browser. With `kernel({ scope: 'attempt' })`, a crashed or killed worker left its attempt's browser running until Kernel's `timeout_seconds`, ten minutes by default; a replacement a worker leased in `worker` scope leaked the same way. A `BrowserProvider` can now implement `sweep(context)`, which the engine calls once per target when the run ends to release the run's leases a worker left open, and `kernel()` deletes every browser still active with the run's `e2e_run` and `e2e_target` tags. The reporter names each browser it released.
