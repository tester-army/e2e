---
'e2e': minor
---

The run telemetry event now names the error that decided the status (`primary_error_code`), counts attempts and the tests that needed a retry, counts the agent's actions by the runner's own names with a project's tools folded into one `tool` bucket, files an engine, provider, or plain failure under a kind from a closed list read off its message (`MODEL_PROVIDER_FAILED:rate-limit`, `ENGINE_FAILURE:device`, ...) without sending the message, and says whether the provider priced the model calls (`cost_source`).
