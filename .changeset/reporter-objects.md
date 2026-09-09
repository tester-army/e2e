---
"@e2edev/e2e": minor
---

`reporters` accepts reporter objects beside `list`, `json`, and `junit`, and
those three are now reporters on the same contract. A `Reporter` has a `name`,
an optional `onEvent` that sees every run event as the `list` reporter does,
and an optional `onRunFinished` that receives the finished run (the report-1
document, `projectRoot`, `reportPath`, `artifactsRoot`, `aiTracePath`) once
the summary has printed, awaited for up to a minute and abandoned by a forced
interrupt; the summary rows it resolves with print under the `list` summary. A
reporter can never change the run's status or exit code: a failure, a timeout,
or a malformed result is one line on stderr. That now holds for `junit` too:
`junit.xml` is written after `report.json`, a write that fails is a stderr
line rather than a `REPORT_WRITE_FAILED` run error, and `junitPath` is gone
from the `run-finished` event. `--reporter` replaces the built-in ids only and
never removes a reporter object, and reporter objects stay out of the config
digest. `Report`, `RunEvent`, and `RunEventOf` join the main entrypoint so a
reporter types its handlers. The CLI also exits as soon as the run ends: a
managed app or service that shut down on `SIGTERM` no longer leaves its
shutdown timer holding the process for up to ten seconds.
