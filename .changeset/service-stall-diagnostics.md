---
"@e2edev/e2e": patch
---

A `command` or service that fails to start now says what it was doing. When
`log` is set, the `APP_UNREACHABLE` message ends with the last 20 lines
appended to the log since the process started (terminal controls stripped,
each `command.env` value replaced by its `<secret:NAME>` marker, at most 4 KB), or `no output in <log>` when
nothing was appended; without `log` it says to set one. A wait that passes
half of `startupTimeout` (once that half is at least 5 s) prints one notice,
`service "compose" still starting after 90s: waiting for it to exit; log:
.e2e/logs/services.log`, so a stalled `docker compose up --wait` is visible
while it stalls and diagnosable from the report alone (#158).
