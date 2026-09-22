---
'@e2edev/mobile': patch
---

A timeout agent-device itself reports (a simulator boot, the runner connecting, an app launch) keeps its message and hint under `ENGINE_FAILURE`. It was re-coded `OPERATION_TIMEOUT` on the word "timed out" alone, and the runner reports that code as a bare `operation timed out`, so the device, the app, and the hint never reached the report.

A busy or wedged iOS automation runner is named as such. agent-device's `RUNNER_BUSY` (still draining a capture that overran its watchdog), `RUNNER_WEDGED`, and `MAIN_THREAD_TIMEOUT`, and a snapshot the runner acquired but could not present ("requires a valid viewport"), read as `APP_UNREACHABLE: agent.act failed: snapshot failed: The iOS runner is still finishing ...` with the app blamed. The message now says the app is fine, names the session and device, and gives the recovery: wait for the runner to drain, and if the next run meets it again, `npx agent-device daemon stop` and reboot the simulator. A runner that is busy or wedged when `prepare` warms the device ends the run there instead of being logged as "not warmed up" and failing the first observation, and the sessions warm-up opened are closed when the run ends, so the next run does not resume them by name with that runner state. A snapshot the runner could not present is taken once more before it fails the step, like a sparse one.
