---
"e2e": patch
---

With several workers, `--max-failures` no longer lets the worker whose failure reaches the limit start its next test. That test was cancelled a moment later and reported `interrupted`; it is now skipped with cause `failure-limit`, as the docs say.
