---
"@e2edev/e2e": patch
---

The bundled skill and the `init` scaffold now describe e2e as agentic testing first. The skill's workflow tells a coding agent to drive a flow with `agent.act` and pin each outcome with `expect`, to use `screen` for exact values, to commit the trace cache so CI replays passing steps, and to specialise the agent for the app (goal wording, `context`, `system`, tools, model options) before rewriting a goal as clicks. The CI guidance runs agent steps in the same job as everything else instead of a separate config on a schedule. The scaffold's config and example test carry one comment each instead of five, and say "natural language" where they said "plain language".
