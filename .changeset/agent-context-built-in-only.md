---
'e2e': patch
---

A custom `StepExecutor` with a `context` member of its own is no longer read as the agent's vocabulary. Only the built-in agent's `createAgent({ context })` and the agent entry's `context` key count, and the executor contract has no `context` field.
