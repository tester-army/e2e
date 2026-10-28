---
"@e2e-dev/github": patch
---

An `e2e explore` run posts its own pull request comment. Before, a job that ran `e2e run` and then `e2e explore` replaced the test results comment with the exploration's. Test run comments keep their marker, so the comments already on open pull requests are still updated. An exploration comment an earlier version posted is no longer updated; delete it. A `--last-failed` rerun no longer folds in an exploration's report that shares its output directory.
