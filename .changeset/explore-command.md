---
"@e2edev/e2e": minor
---

`e2e explore [goal]` runs the agent against the app with a goal instead of a
test file. It plans one exploration step at a time from the goal, the steps
and findings so far, and the current screen; runs each charter as an
`agent.act()` step of the built-in agent, with the project's tools plus a
`report_finding` tool that records a defect with its severity and reproduction
steps, the current path when the engine reports one, and a redacted screenshot
when the engine grants pixels; and ends with a closing assessment when the goal
is covered, at the step limit (`--max-steps`, 1 to 12, default 8), at the wall
clock (`--timeout` in milliseconds, 180000 to 900000, default 600000), or
after three failed or blocked steps in a row that reported nothing. A failed
step is recorded and the run goes on; a step that hits its budget ended at its
limit and is not a failure; findings of kind `issue` fail the run (exit 1),
warnings do not; a run that explored nothing and found nothing is blocked,
never a pass. The run is an ordinary run of one in-memory test under the
virtual file `explore`, so reporters, `.e2e/report.json`, artifacts,
`--video`, `--ai-trace`, `--debug`, and Ctrl-C behave as for `e2e run`; the
report gains `run.explore` with the goal, budgets, steps, findings, and
assessment, and the `list` reporter prints the findings under the summary. The
model is `agent.model` or `E2E_MODEL`. An agent built with
`createAgent({ tools, system })` lends its vocabulary to the explorer:
`createAgent` now returns a `DefaultAgent` whose `tools`, `system`,
`maxTurns`, and `providerOptions` are readable. `e2e guide explore` prints the
new skill topic.
