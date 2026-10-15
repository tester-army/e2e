---
"e2e": patch
---

An `openHost()` session closed after its deadline now always ends as timed out: `close()` returns the `TEST_TIMEOUT` and the trace says timed out, even when the deadline passed just before `close()` ran.
