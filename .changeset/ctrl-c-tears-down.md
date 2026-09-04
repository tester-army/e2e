---
"@e2edev/e2e": patch
---

Ctrl-C now ends the run and tears the backend down. The first signal interrupts the running test immediately (it no longer waits for the test timeout when the body is not calling the harness), runs its bounded cleanup, disposes every worker's backend, and writes the report. A second signal forces every worker to dispose at once and kills it after the cleanup budget; a third exits on the spot. A worker whose runner disappears disposes its backend and exits instead of running on. The event stream gains `run-interrupted`.

The signal ladder is the CLI's. `run()` from `@e2edev/e2e/run` no longer installs `SIGINT`/`SIGTERM` handlers and never exits the process; a host passes `interruptSignal` and the new `forceSignal` instead.
