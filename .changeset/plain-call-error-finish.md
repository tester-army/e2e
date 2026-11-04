---
"e2e": patch
---

A model call without a response schema that the provider ends on an `error` finish now fails as `MODEL_PROVIDER_FAILED` instead of `MODEL_OUTPUT_INVALID`.
