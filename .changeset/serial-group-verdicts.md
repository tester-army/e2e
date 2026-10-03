---
"e2e": patch
---

A serial group whose session fails to launch, or whose file fails to load, now fails the run. Before, every member was skipped and the run passed with exit code 0. The first member now fails with the launch error and the rest skip with cause `serial-predecessor-failed`, so the `list` reporter, `summary.md`, and `junit.xml` show the failure. A retry that fails to launch keeps the members' verdicts from the attempt before it, so a member that failed there still fails. An infrastructure error in a serial group, at launch or in a member, now exits 3 and sets the run status to `error`, as it does for any other test, instead of exiting 1. When a worker crashes during a serial group, the member that was running fails with `WORKER_CRASH` instead of being skipped as if it never started.
