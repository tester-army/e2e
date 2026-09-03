---
'@e2edev/e2e': minor
---

Foundation work for executors that diff screens and replay long flows
reliably; no behaviour of the built-in agent changes beyond its history hook.

Chassis (`createToolLoopExecutor`): `prepareMessages(messages, turn)`
replaces `compactMessages`. It runs between turns, its result carries forward
to later turns, and it may return `{ messages, stop }` to force the
conclusion when the executor has evidence the loop guards cannot see.
`providerOptions` are passed to every model call. `createAgent` accepts
`providerOptions` too. `isDefinedTool`, `toolAppliesTo`, `PreparedTurn` and
`PreparedMessages` are exported from `@e2edev/e2e/agent`; `RUNTIME_CODES` from
`@e2edev/e2e`. `ExecutorObservation` carries the current `path` when the
backend reports one.

Trace cache: a typed value that appears in neither the step's instruction
nor its params was derived at run time and is recorded as a gap, so replay
hands the step over before it instead of typing a value the app may not
issue again. A trace records how long the recording run took to reach its
end state (`endWaitMs`), and replay waits that long (plus a margin, bounded
by the step clock) for the end anchors before it self-finalizes. Every
targeted action records the key of the row or list item it sat in
(`within`), and relocation requires it to hold, so same-named controls in
different rows replay without a guess. The replay policy version bumps, so
existing caches cold-start.

Breaking for `createToolLoopExecutor` callers: `compactMessages` is replaced
by `prepareMessages`.
