---
'e2e': patch
---

The tools the agent calls have closed schemas. A field a tool does not declare (`force`, `selector`, a second target) used to be stripped and the call run without it; it now fails validation, and the refusal goes back to the model as the call's result, naming the field, so its next turn is the repair. A call to a tool the step does not offer is refused the same way, with the names it may use, and so is a `complete_step` that pairs `status: "passed"` with an `errorCode` (a live run had a pass carry `ACTION_FAILED`; `errorCode` is only valid with status `failed` or `blocked`). None of them runs anything, all count toward the failure streak that forces a verdict, and the step's turns record them. `e2e mcp` `call` refuses an undeclared argument with `INVALID_ARGUMENT`, as it already did a wrong type.
