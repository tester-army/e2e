---
"@e2edev/e2e": minor
---

`agent.act` takes one options bag and resolves with what the step did.
`params` moves inside the options: `act('x', undefined, { timeout })` becomes
`act('x', { timeout })`, and `act('x', { email })` becomes
`act('x', { params: { email } })`. The result is an `ActResult`, with the
executor's `summary`, the `modelCalls` and `actions` the step spent, and
`cache`, how the trace cache took part, instead of `{ ok: true }`.
`ActOptions` and `ActResult` replace `AgentOptions` and `AgentResult`. A
call in the old shape fails with `INVALID_ARGUMENT` naming the move, from a
JavaScript test as from a typed one, instead of running with its parameters
silently ignored.
