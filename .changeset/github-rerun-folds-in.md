---
'@e2e-dev/github': patch
---

A `--last-failed` rerun updates the pull request comment as one run instead of shrinking it to the tests it ran again. The tests the rerun left out keep their results from the run it selected from, a test that failed and then passed shows as flaky with both runs' attempts, a test that failed again stays failed, and the counts cover the whole suite, so `e2e run || e2e run --last-failed` in one step leaves a comment that says what the job's status says.
