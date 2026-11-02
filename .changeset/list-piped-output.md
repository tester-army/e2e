---
"e2e": patch
---

The `list` reporter prints each test as it finishes when stdout is not a terminal (piped, redirected, most CI), instead of only once its whole file finishes, and ends every run with a `Failed` row per failed test (`file:line`, the error's first line, the trace page when one was written), so `e2e run | tail` still names what broke.
