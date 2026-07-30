---
'e2e': patch
---

Harden agent model calls against transient provider failures.

Transport retries per model call go from 2 to 5. Only failures the provider
marked retryable are retried, `retry-after` is honored, and the remaining step
timeout still bounds the whole chain, so a healthy provider is unaffected while
a rate-limited or briefly 5xx-ing one no longer fails the step.

An exhausted retry chain now reports the provider failure that actually
occurred in `MODEL_PROVIDER_FAILED` instead of the SDK's retry wrapper, and a
chain cut short by the deadline still classifies as `STEP_TIMEOUT`.
