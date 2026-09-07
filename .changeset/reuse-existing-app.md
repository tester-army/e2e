---
"@e2edev/e2e": patch
---

A backend's `command` and its `readyUrl` services accept `reuseExisting: true`: when the readiness URL already answers before the spawn, the runner attaches to that process instead of starting its own, reports `<label>: reusing the process already serving <url>`, and leaves it running on teardown (a reused service also skips its `teardown`). Off by default. CI ignores the flag with a notice. Setting it on a `waitForExit` service or a `teardown` command is `INVALID_CONFIG`.

The runner now always probes `readyUrl` once before spawning, within `startupTimeout`. Without `reuseExisting` in effect, a URL that already answers fails the launch with the new `APP_ALREADY_RUNNING` (infrastructure, exit 3) instead of letting the old server pass as the new command's readiness, so tests no longer run against stale code by accident.
