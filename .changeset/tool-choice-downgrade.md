---
"e2e": patch
---

The agent loop handles providers that downgrade a forced tool choice instead of refusing it, as the AI SDK's Anthropic provider does for Claude models that reject forced tool use (Claude Sonnet 5.5 through `@ai-sdk/anthropic`). Such a request succeeds with `auto`, so the HTTP 400 path never ran: the loop kept asking for a forced choice, the SDK logged an `AI SDK Warning ... toolChoice` line on every turn, steps ran without the tool-calls-only instruction, and a turn the model answered in prose failed the step with `MODEL_PROVIDER_FAILED` (the SDK's `ToolChoiceViolationError`). Now a `toolChoice` call warning switches the step to `auto` and gives its remaining turns the instruction, a prose answer under a forced choice is retried with `auto` like a refusal, and later steps on that model start in `auto`.
