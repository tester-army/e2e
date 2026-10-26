---
"e2e": patch
---

`e2e/runner` exports `explore()`, the counterpart of `e2e explore` that `run()` is to `e2e run`. It takes the project (`cwd`, and `config` as a file path or an `E2EConfig` value), the goal and its budgets (`goal`, `target`, `agent`, `session`, `maxSteps`, `timeoutMs`), `interruptSignal`, and `onEvent`, and resolves with the run's result plus the exploration record (`explore.ended`, `explore.steps`, `explore.findings`) without exiting the caller. Cancellation awaits teardown. The notices `e2e explore` prints before the run starts, such as the target it chose, arrive through `onEvent` as `run` notices. It shares `run()`'s reservation, so overlapping calls reject with `RUNNER_BUSY`, and each exploration that returns a report sends one `e2e_run_completed` event with `command: "runner.explore"`.
