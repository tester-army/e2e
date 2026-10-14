---
"e2e": patch
---

A model the provider does not serve to the account, which GitHub Copilot answers with `model_not_supported` for a model the plan does not include or the settings turned off, now stops the run once with `MODEL_UNAVAILABLE` naming the model and the cause, instead of failing every test with `MODEL_PROVIDER_FAILED` and the provider's bare sentence. The Subscriptions page says what the Copilot listing cannot show: on Copilot Free, GitHub serves models through auto model selection only, so a model called by id is usually refused.
