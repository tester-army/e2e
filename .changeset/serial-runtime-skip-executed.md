---
"e2e": patch
---

`run.summary.executed` now counts a serial member whose body ran, the same way it counts an ordinary test. Before, it left out a member that called `test.skip()` in its body, and a member that ran in one group attempt before a retry skipped it behind a failed predecessor. The run's telemetry cache tiers count them the same way.
