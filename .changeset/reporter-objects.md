---
"@e2edev/e2e": minor
---

`reporters` accepts reporter objects beside `list`, `json`, and `junit`. A
`Reporter` has a `name`, an optional `onEvent` that sees every run event as
the `list` reporter does, and an optional `onRunFinished` that receives the
finished run (the report-1 document, `reportPath`, `artifactsRoot`,
`junitPath`, `aiTracePath`) once the summary has printed, awaited for up to a
minute and abandoned by a forced interrupt; links it resolves with print under
the `list` summary. A reporter can never change the run's status or exit code:
a failure, a timeout, or a malformed result is one line on stderr.
`--reporter` replaces the built-in ids only and never removes a reporter
object, and reporter objects stay out of the config digest. `Report`,
`RunEvent`, and `RunEventOf` join the main entrypoint so a reporter types its
handlers. The CLI also exits as soon as the run ends: a managed app or service
that shut down on `SIGTERM` no longer leaves its shutdown timer holding the
process for up to ten seconds.
