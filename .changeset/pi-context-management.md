---
"@e2edev/e2e": minor
---

The agent loop addresses the provider's prompt cache, keeps its history
cacheable, and recovers once from a request the model cannot fit.

- Every model call carries what the provider needs to serve the repeated
  prefix from its cache: on Anthropic models a cache breakpoint on the system
  prompt (covering the tool definitions) and one on the newest message, moved
  forward each turn; on OpenAI models a prompt-cache key derived from the
  system prompt, so every call of a run routes to the same cache. A caller's
  own `providerOptions` win on conflict. Other providers see no change.
- Superseded full screens are no longer elided one turn at a time. They stay
  verbatim until they together outgrow 32 KB, then go in one batch, so the
  request prefix stays byte-identical across the turns of a step and the
  cache can serve it. A two-turn step whose screens fit the budget never
  elides.
- The report records the cache split: `model.cacheReadTokens` and
  `model.cacheWriteTokens` per step, `usage.modelCachedTokens` per run, the
  `list` reporter's usage line shows the cached share (`12.4k tokens · 38%
  cached`), `--debug` adds a `cached` column to the agent step table, and
  the run telemetry event gains `model_cached_tokens`.
- A request the provider refuses as larger than the model's context window
  is recognized (the error catalog covers twenty providers and the HTTP 413
  some answer with) and retried once with the step's history shrunk:
  superseded screens elided, any text longer than 16 KB cut to its head with
  a notice. The retry continues the same turn budget and is skipped when
  shrinking would change nothing. A second refusal, a refusal nothing could
  shrink, or one on a judgment call, is the new `CONTEXT_OVERFLOW` code
  (blocked: automation) instead of `MODEL_PROVIDER_FAILED`.
- A text result from a project tool is bounded to 400 lines or 16 KB,
  whichever comes first, notice included. The cut lands on a line boundary,
  except for a single line that alone exceeds the budget, which keeps its
  head; the notice names how much was left out. Structured results pass
  through unchanged.
