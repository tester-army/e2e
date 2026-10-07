---
"e2e": patch
---

A model call that finishes with reason `content-filter` fails as `MODEL_REFUSED` (exit 1). The message names the step, the model, and the provider's raw finish reason. The same call used to fail as `MODEL_PROVIDER_FAILED` with "No output generated" (exit 3), so a retry policy keyed on a provider outage sent the refused prompt again.
