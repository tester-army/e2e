---
"e2e": patch
---

A structured model call that returns no parseable output (for example an empty `length` finish) now fails as `MODEL_OUTPUT_INVALID` instead of `MODEL_PROVIDER_FAILED`.
