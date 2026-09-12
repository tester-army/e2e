---
"@e2edev/e2e": minor
---

Judgments are independent of the act loop. `agent.assert`, `agent.waitFor`,
and `agent.extract` are shown the instruction and the current screen only:
the prior-step ledger and the acting agent's summaries no longer reach a
judgment call, so a verdict rests on what is on screen rather than on the
actor's account of what it did. A new `judge` slot, `agents.<name>.judge` or
`createAgent({ judge })`, names a separate model for the judgment tier;
unset, judgments use `model`, and a config `judge` that differs from the
executor's is `INVALID_CONFIG`. Each judgment step's `model` in the report
names the model that produced the verdict.

The judgment protocol is `agent-judgment-2`: the model answers `holds`,
`fails`, or `inconclusive` instead of a boolean. An inconclusive
`agent.assert`, one where the screen did not show enough to decide either
way, fails with the new `ASSERTION_INCONCLUSIVE` code (category test, exit 1)
and the model's account of what was missing; it is never a pass. In
`agent.waitFor` an inconclusive round keeps polling until the deadline.

The report records the checkout under `run.vcs`: `commit`, `branch` when
HEAD is on one, and `dirty` when git could say. Outside git the GitHub
Actions variables stand in; with neither, the field is absent. It is what
joins a run's verdicts to the pull request that produced the code.
