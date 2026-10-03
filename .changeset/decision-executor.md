---
"@e2e-dev/decision": minor
---

Add `@e2e-dev/decision`, an executor that runs `agent.act` and `agent.assert`
through a decision model instead of an LLM. It takes any AI SDK evaluation
model with choice distributions and decides through `experimental_evaluate`,
one call per action with the operation and target questions fanned out; a
small language model writes field values when the choice is `type`. Tests
stay plain natural language with no params. Probability and confidence
gates are off by default.
