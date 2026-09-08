---
"@e2edev/e2e": minor
---

The CLI sends anonymous usage telemetry: one `e2e_cli_session` event per
command (the command, its flags, the e2e, Node, and OS versions, the machine
class, the CI vendor, the coding agent) and one `e2e_run_completed` event per
run built from the report's own numbers (status, counts, durations, engine
names, cache replay counts, model provider, token totals, error codes). Test
names, file paths, URLs, instructions, messages, and credentials are never
sent. Opt out with `e2e telemetry disable`, `E2E_TELEMETRY_DISABLED=1`, or
`DO_NOT_TRACK=1`; `E2E_TELEMETRY_DEBUG=1` prints every event instead of
sending it. Hosts embedding `@e2edev/e2e/run` send nothing.
