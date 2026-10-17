---
"e2e": patch
"@e2e-dev/decision": patch
---

`agent.extract` (and the built-in agent's other judgment calls) now fail with a typed, non-retryable `MODEL_REFUSED` when the model refuses the request (finish reason `content-filter`) — the message names the step, the model, and the finish reason, and the run exits 2 — instead of misreporting the refusal as `MODEL_PROVIDER_FAILED` or spending a repair round on it as `MODEL_OUTPUT_INVALID`; a decision model refusing a question now reports `MODEL_REFUSED` too, so one code covers the concept.
