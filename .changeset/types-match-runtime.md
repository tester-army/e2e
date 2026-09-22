---
'e2e': patch
---

The public types say what the runner does. `E2EConfig.targets` is required at the type level, as the loader has always demanded: `({ cache: 'read-write' }) satisfies E2EConfig` no longer compiles and fails at load with `INVALID_CONFIG`. `ModelInstance` carries the `doGenerate` member the config check reads, so an object of three id strings is rejected by `tsc` rather than by the loader. `RunStatus`, `RunExitCode`, `StepTurn`, `PointHit`, `PointTapResult`, and `ExecutorVerb`, each named by a public signature, are exported from `e2e`. `agent.assert` under a custom `StepExecutor` accepts `screenshot`: the runner takes that evidence after the verdict, so it is attached to the step as on the default path, and `screenshot: false` opts out; `vision` stays `UNSUPPORTED_CAPABILITY` there, because the executor decides what its model sees.
