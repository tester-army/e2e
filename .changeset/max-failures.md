---
'e2e': minor
---

`e2e run --max-failures <n>` (`RunOptions.maxFailures`) stops the run once that many tests have failed or timed out: nothing more is dispatched, the tests running end as `interrupted`, and the tests not started are skipped with the new cause `failure-limit` and the reason `run stopped after 3 failures (--max-failures 3)`; the exit code is the failures' own. Reporters get a `run-stopped` event with the count and the limit. The report schema's skip causes gain `failure-limit`.
