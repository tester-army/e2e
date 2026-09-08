---
"@e2edev/e2e": minor
---

`RunOutcome.status` and the `run-finished` event carry the same status as
`report.run.status`, `blocked` included. A run whose every non-passing
result was blocked (credentials, environment, or the agent's own budget) used
to report `failed` to the host and `blocked` in `report.json`; the
`RunStatus` type on `@e2edev/e2e/run` names the union.
