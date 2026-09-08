---
"@e2edev/e2e": minor
---

`agent.act` no longer advertises options the runtime rejects. The `schema`
overload (`AgentSchemaOptions`, `AgentResultWithData`) and the `vision`
option are gone from the `Agent.act` type. Both threw `UNSUPPORTED_CAPABILITY`
on every call, so no passing test changes; a call that passed either now fails
to compile instead of at run time. Structured output is
`agent.extract({ schema })`, and `vision` stays an option of `assert`,
`waitFor`, and `extract`.
