---
'e2e': minor
---

A failure now hands off what the screen held, not only what was asked. When
an attempt fails with the session still open, the runner looks once more and
records the evidence on the attempt as `failure`: the location, the redacted
screen as the agent reads it (a `log` artifact, `failure/screen.txt`), a
masked screenshot when the run keeps screenshots and no secret was filled,
and for a locator that matched nothing or too much, the nodes on screen
closest to what it asked for. Every step records the test line it was called
from as its `source`, and an error carries the line it unwound through as
`source` too, so a report reader no longer needs the terminal's code frame.
Errors carry structured `details` beside the message: an `expect` failure's
`locator`, `expected`, `observed`, and `matches`; a locator failure's
`locator`, `role`, `name` or `testId`, and `waitedMs`. An agent step records
its last model turns as `turns`, each turn's tool calls and what came back,
clipped, whatever the debug setting; the full transcript stays behind
`--debug`. The `markdown` reporter renders all of it: the failure block gains
the expected and observed facts, what the locator asked for, whether every
attempt failed the same way, the last turns of a failed agent step, the
screen's location and the closest nodes, one evidence path per kind, and a
link to the test's own page under `.e2e/failures/`, one page per failed or
flaky test with every step, every kept turn, and the screen text inline. The
list reporter prints the location, the closest nodes, and the screen text's
path under each failure. Report-1 gains the optional `error.details`,
`error.source`, `attempt.failure`, and `step.turns` fields; `step.source` is
no longer always `unknown`.
