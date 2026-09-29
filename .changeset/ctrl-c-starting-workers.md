---
'e2e': patch
---

A Ctrl-C that reaches workers still loading, before they ignore the signal, no longer reports `WORKER_INIT_FAILED` and skips the target's tests as `infrastructure-unavailable`. A worker that dies of SIGINT, SIGTERM, or SIGHUP before it is ready is not a boot failure; the run's interrupt skips the tests as `run interrupted before execution`.
