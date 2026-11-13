---
"e2e": patch
---

With several workers, `--max-failures` no longer lets the worker whose failure reaches the limit start its next test. That test was cancelled a moment later and reported `interrupted`; it is now skipped with cause `failure-limit`, as the docs say.
The runner alone counts failures toward the limit, and a worker waits for its answer to each failure before it starts another test.
