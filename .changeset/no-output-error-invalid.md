---
"e2e": patch
---

A structured call whose model produced no output (the SDK's `NoOutputGeneratedError`, e.g. an empty `length` finish) now fails as `MODEL_OUTPUT_INVALID` — a test verdict with repair budget — instead of `MODEL_PROVIDER_FAILED`.
