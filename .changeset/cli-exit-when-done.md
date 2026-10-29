---
"e2e": patch
---

An `e2e` command whose config or test file leaves a timer or socket open exits two seconds after it finishes, instead of staying open.
