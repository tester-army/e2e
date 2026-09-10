---
"@e2edev/e2e": patch
---

`agent.act` runs on models that refuse a forced tool choice. The loop asks
every model for a tool call per turn and names `complete_step` on the final
ones; a model that answers HTTP 400 to that request shape (Anthropic's Claude
Fable 5.1 does) is asked again with `auto` and a tool-calls-only rule in its
instructions, on the same turn budget, and later steps on that model start in
that mode. A turn that comes back as prose without a tool call no longer ends
the step: the reply stays in the history and the model is told to act, until
the turn budget runs out as before.
