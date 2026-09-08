---
"@e2edev/e2e": patch
---

A third Ctrl-C kills the process groups of every app command and service the
run started before exiting, so they no longer survive the forced exit and
fail the next run with `APP_ALREADY_RUNNING`.
