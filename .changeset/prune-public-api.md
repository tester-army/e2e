---
"@e2edev/e2e": minor
---

Removes public API that had no consumer, was deprecated, or duplicated another surface, so what remains is what the runner actually enforces.

- `ExecutorBudgets.recordToolCall` (deprecated): use `runTool`, which reserves the action budget before the tool body runs.
- `ToolAnnotations.replay` and `ToolAnnotations.secrets` (deprecated, never read): `defineTool` takes `{ mutates, platforms? }`.
- `StepExecutorContext.priorSteps` and `ExecutorPriorStep`: the ledger string is the executor's prior-step context.
- `createToolLoopExecutor` options `onConclude`, `loopGuards`, and `windDown` (and the `WindDownPolicy` / `LoopGuardThresholds` types): the chassis keeps its own loop guards and wind-down policy.
- The `@e2edev/e2e/agent` primitives `createGrammarTools`, `createVerdictTool`, `trackModelCalls`, `conversationMemory`, `VERDICT_RULES`, `serializeLedger`, `compactSnapshotHistory`, and `formatReplayedPrefix`: `createAgent` and `createToolLoopExecutor` are the two supported layers.
- `blockedCategoryOf` and `BlockedCategory` from the main entrypoint.
- The legacy fixture adapter: an engine fixture factory must return the surface it declared through `context.fixture`; a plain surface is rejected with `INVALID_CONFIG`.
