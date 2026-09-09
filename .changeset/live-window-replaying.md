---
"@e2edev/e2e": minor
---

The list reporter's live window reads `Replaying` instead of `Thinking`
while the trace cache has an `agent.act` step, from the moment a cached
trace is found until the step ends or a replay that could not finish it
hands the step to the model, when the row reads `Thinking` again.
`StepProgress` gains the `replay` phase that carries this to any reporter:
`{ phase: 'replay', api, active }`.
