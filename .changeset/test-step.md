---
'e2e': minor
---

`test.step(title, body)` groups the steps a test body calls under one named step. The report records a `test.step` step of kind `test` with the title as its label, and every step the body called (`screen` actions, `expect`, `agent.act`) carries its id in the new `parent` field, so a report can show a page object's or a helper's work as one line with the calls under it. Steps nest, the body's result is returned, a body that throws fails the step with that error, and a body that returns before a step it called finished fails with `STEP_NOT_AWAITED`. Failure pages and the run summary point at the call that failed inside the step, not the step; the `list` reporter shows `test.step` rows and indents what ran inside them; step progress carries `identity.parentStepId`.
