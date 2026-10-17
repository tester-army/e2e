---
"e2e": patch
---

A model that refuses a request (finish reason `content-filter`) now fails the step as `MODEL_REFUSED` instead of `MODEL_PROVIDER_FAILED` with "No output generated". Rephrase the instruction or use another model.
