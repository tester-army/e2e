---
'e2e': minor
---

`createAgent` accepts `context`, with the value and meaning of `agents.<name>.context`: trusted project vocabulary prepended to every act turn and judgment of that agent. `{ executor: createAgent({ model, system, context }) }` is now a complete agent, so the options object around it needs no second `model` or `context` key. Naming a different `context` on both `createAgent` and the options object is `INVALID_CONFIG`, as it is for `model`; the same value on both is accepted. `StepExecutor` gains an optional `context` member for the same reconciliation.
