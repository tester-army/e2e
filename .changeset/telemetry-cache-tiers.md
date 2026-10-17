---
"e2e": patch
---

The run telemetry event now sorts executed tests by how the replay cache carried them (`tests_code_only`, `tests_replayed`, `tests_assisted`, `tests_live`), counts `agent.act` steps that ran with the cache off (`agent_steps_uncached`), why steps missed the cache or handed off (`agent_miss_reasons`, `agent_handoff_reasons`), and the model calls by agent entry point (`model_calls_act`, `model_calls_assert`, `model_calls_extract`, `model_calls_waitfor`).
