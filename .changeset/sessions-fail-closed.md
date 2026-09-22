---
'e2e': patch
---

A setup test whose `session.save()` the runner cannot persist (the engine captured state that is already expired, or `.e2e/sessions` cannot be written) fails with that error and its dependents are skipped as `setup-failed`, exit 1. The failure used to escape the attempt and take the worker down: the setup read `failed (WORKER_CRASH)`, the run carried a `WORKER_EXIT` error, and exited 3. A retry whose test file fails to re-import is recorded against the test the same way instead of ending the worker.

A session envelope missing `iv`, `tag`, or `ciphertext`, or carrying one that is empty or not a string, is `SESSION_INVALID` rather than a raw `TypeError` classified as a test error.

Session directories a killed run left under `.e2e/sessions` (a third Ctrl-C, `SIGKILL`, a crash; the memory-only key is gone with the process) are removed by the next run once they are older than 24 hours, the longest a session may live.
