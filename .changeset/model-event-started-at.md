---
"@e2edev/e2e": patch
---

`model` step events carry the moment the request went out as `startedAt`,
not the moment the executor reported the turn. `ExecutorModelCall` gains an
optional `startedAt`; the built-in tool loop fills it. The list reporter
shows a step's events in stream order instead of moving each turn ahead of
the tool calls it made.
