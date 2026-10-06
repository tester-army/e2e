---
"@e2e-dev/decision": minor
---

Add `@e2e-dev/decision`, an executor that runs `agent.act` and `agent.assert`
through a decision model instead of an LLM. It takes any AI SDK decision
model with choice distributions (`evaluationModel()` instances too) and
decides through `experimental_decide`, so it needs `ai` 7.0.128 or later. One
call per action fans out the operation and target questions; a small
language model writes field values when the choice is `type`. Tests stay
plain natural language with no params. Probability and confidence gates are
off by default. A model id string or a language model fails config load with
`INVALID_CONFIG`.
