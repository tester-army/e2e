---
'e2e': minor
---

The programmatic host surface lands as `e2e/run`. `run()` executes one
complete run in-process — no `process.exit`, external `AbortSignal`
cancellation, the full report-1 document returned in memory — and the new
`onEvent` option streams every lifecycle fact (`run-started`, `plan`,
`test-started`, per-step `start`/`end`/child events, `test-finished`,
`serial-group`, `run-error`, `run-finished`) as plain JSON data with an
emitter-stamped `seq`. A sink that throws is quarantined for the rest of the
run instead of affecting it. The CLI is a thin consumer of exactly this
surface; `report.json` stays the canonical record. Cancellation is honored from the first moment of the run — app startup and collection, not only once the scheduler is live — and a failure during teardown (session store, app process) now reaches the exit code instead of being recorded and dropped.
