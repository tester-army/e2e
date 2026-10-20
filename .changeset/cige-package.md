---
"@e2e-dev/cige": patch
---

Add `@e2e-dev/cige`, which runs CIGE test cases: Context, Intent, Guardrails,
and Execution as a portable `.cige.json` file. `cigeSuite` registers one test
per case, tagged `cige:<id>` and titled by its Intent. It runs each Execution
step as an `agent.act` goal with the guardrails on its instruction, stops the
step with `POLICY_DENIED` on an action a guardrail denies, and passes only
when the Intent's evidence holds. The `cige()` reporter writes one run summary
per case with a first classification (infrastructure, outdated test logic, or
product defect) for the agents that repair it.
