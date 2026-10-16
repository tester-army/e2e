---
"e2e": patch
---

`copilot()`: a model GitHub Copilot does not serve to the account (`model_not_supported`) now stops the run once with `MODEL_UNAVAILABLE` naming the model and the cause, instead of failing every test with `MODEL_PROVIDER_FAILED`.
