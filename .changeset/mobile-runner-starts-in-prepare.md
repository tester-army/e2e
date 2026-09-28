---
'@e2e-dev/mobile': patch
---

The iOS automation runner starts in `prepare`, through agent-device's `prepare ios-runner`, before the warm-up open. A cold runner used to start inside the first test's `app.open()` (or the warm-up open), under agent-device's 90 s `open` envelope; on a loaded CI Mac it outlasted that, and a timed-out `open` resets the daemon, which ended the other workers' sessions with it (`Daemon request timed out`, then `2 devices match this request equally`, `Invalid daemon response`). A build the suite installs itself now gets the runner start too.
