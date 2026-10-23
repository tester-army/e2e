---
"e2e": patch
---

A run now exits 3 when a test passed but its cleanup failed. A required video that could not be finalized, or a session that would not close, is an artifact/infrastructure failure, so the run no longer reports success while a requested recording is missing.
