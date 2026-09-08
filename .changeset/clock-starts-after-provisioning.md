---
'@e2edev/e2e': patch
---

A first-run browser download is no longer on the run's clock. The runner now
collects and selects tests, lets every engine provision what it needs
(`prepare`), and only then emits `plan`, starts the app, and runs. The list
reporter's `Start at` and `Duration` and the report's `run.startedAt` count
from `plan`, so a run whose only test took 3s no longer reports 17s because
Chromium was fetched first, and the live window shows no ticking duration while
a download narrates above it. Collection failures such as `NO_TESTS` are now
reported before any app command starts.
