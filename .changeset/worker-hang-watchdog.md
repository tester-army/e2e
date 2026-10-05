---
'e2e': patch
---

A test that blocks its worker's event loop (`while (true) {}`) no longer hangs the run until Ctrl-C. When the worker has not responded `cleanupTimeout` (at least 5 s) after the test timeout, the runner kills it, reports the test `timed-out` with `TEST_TIMEOUT`, and runs the rest of the file on a new worker. A worker with a debugger attached when the test starts (an editor's auto-attach, or `NODE_OPTIONS=--inspect=0`) is never killed this way. Runs with an inline config or in-memory tests run in the runner's own process and still hang.
