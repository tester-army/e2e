---
"e2e": patch
---

Agent steps on DeepSeek's V4 models no longer fail on their first turn with `MODEL_PROVIDER_FAILED`. In thinking mode, DeepSeek's default, the API refuses a forced tool choice with `Thinking mode does not support this tool_choice`; that refusal now reads as one, so the step retries with `auto` and the tool-calls-only rule, as it already did for Anthropic, and thinking can stay on.
