---
"@e2edev/e2e": minor
---

A test or a describe block pins the configured agent it runs with through the
`agent` option (`{ agent: 'buyer' }`), and `act`, `assert`, `waitFor`, and
`extract` take `{ agent: 'name' }` to run one call with another. Innermost
wins: a call's agent beats the test's, which beats its groups, which beat the
run; `e2e run --agent <name>` re-points what unpinned tests use and never
overrides a pin. A pin naming nothing in `agents` is a `COLLECTION_ERROR`
before any process starts, with the configured names; an unknown name on a
call is `INVALID_ARGUMENT` before the step opens. Every agent step records the
agent it ran with as `step.agent` in report-1. Each worker checks an agent's
model once, on its first use, and shares the adapter with every agent that
names the same model.
