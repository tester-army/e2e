---
'e2e': patch
---

A Ctrl-C that reaches workers still loading, before they ignore the signal, no longer reports `WORKER_INIT_FAILED`; the run's interrupt skips the target's tests with the reason `run interrupted before execution` instead of `worker process failed to start`. A worker that dies of SIGINT, SIGTERM, or SIGHUP before it is ready is not a boot failure.
