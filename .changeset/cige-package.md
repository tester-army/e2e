---
"@e2e-dev/cige": patch
---

Add `@e2e-dev/cige`, which runs CIGE test cases: Context, Intent, Guardrails,
and Execution as a portable `.cige.json` file. `cigeSuite` registers one test
per case and variant, tagged `cige:<id>` and titled by its Intent, with the
platforms, session, capabilities, and agent the case's Context names. It runs
each Execution step as an `agent.act` goal with the guardrails on its
instruction, stops the step with `POLICY_DENIED` on an action a guardrail
denies, and passes only when the Intent's evidence holds; an evidence hook
holds only when it returns `true`. One `cige.config.ts` (`defineCige`)
declares the cases, hooks, environments, and ref resolvers. The `cige()`
reporter writes one run summary per result with a first classification
(infrastructure, outdated test logic, or product defect), the refs with
`{build}` filled in, and the command that replays it. The `e2e-cige` command
replays a case in its environment (`replay`), runs an environment action
(`env`), resolves a case's spec, release notes, and expected output (`refs`),
lists each case that lacks a spec or build ref, a build, or a resettable
environment before anything fails (`check`, also counted under the run
summary), and fails a change that weakens a case (`diff`).
