---
"e2e": patch
---

The bundled agent skill now gives a coding agent a fast loop for fixing a test: rerun only that test by `file:line` with `--action-timeout 5000`, keep the replay cache on so goals that passed replay without model calls, add `--retries 0` when the config sets retries, don't rename the test or reword a passing goal mid-loop, and, when the test passes, run it one time with `--no-cache`. The coding agents guide no longer tells agents to add `--no-cache` after every change, and the caching guide has a section on rerunning a test while you fix it.
