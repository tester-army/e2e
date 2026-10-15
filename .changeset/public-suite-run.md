---
"e2e": patch
---

Expose `run()` from `e2e/runner` to execute suites with a config file or runtime configuration, stream progress, cancel execution, and return the completed report without exiting the caller.

`openHost` called while a suite is running now fails early with `RUNNER_BUSY`.

Each `run()` that returns a report sends one anonymous `e2e_run_completed` telemetry event with `command: 'runner.run'`, under the same opt-outs as the CLI.
