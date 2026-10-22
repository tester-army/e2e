---
"e2e": patch
---

Add `screen.tree()` and `screen.debug()`. `tree()` returns the whole screen as the agent reads it, one node per line with secrets redacted. `debug()` prints the same text to the test's output.
