---
'e2e': patch
---

A reporter's `FinishedRun` carries `lastRun` on a `--last-failed` run: the report the rerun selected from. The rerun's own report lists the tests it left out as unselected, so a reporter that keeps one place current can fold the rerun into the run before it and show both as one.
