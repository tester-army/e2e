---
"@e2edev/e2e": minor
---

One model, checked once. The model passed to `createAgent({ model })` now
serves the judgment calls (`assert`, `waitFor`, `extract`) as well as `act`,
and outranks `E2E_MODEL`; an `agent.model` that names a different model is
`INVALID_CONFIG`. The runner builds and validates the model adapter once per
run, when the first test acquires the `agent` fixture. A missing model or
credential is one run-level `MODEL_UNAVAILABLE` (exit 2) that stops the run,
instead of one blocked step per test. Deterministic suites and custom
executors without a model are unaffected.
