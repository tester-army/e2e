---
"e2e": patch
---

A judgment (`agent.assert`, `agent.waitFor`, `agent.extract`) on a screen denser than the observation budget now cuts the screen by its instruction's measured size, so a long instruction, or `e2e explore`'s planner once its record of earlier steps has grown, no longer fails the adapter's pre-flight with `STEP_BUDGET_EXHAUSTED: model input upper bound N exceeds the agent's maxInputTokens M` and aborts the run before any request is sent.
