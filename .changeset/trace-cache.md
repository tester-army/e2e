---
'e2e': minor
---

The adaptive trace cache (`trace-1`) lands. Each passing `agent.act()` step
records the grammar actions it performed — durable target descriptors,
secret-free inputs, gap markers for project-tool mutations — and the next run
replays them zero-turn through the same policed grammar. A full replay
self-finalizes the step as passed with zero model calls; any divergence hands
the step to the executor mid-step with a `replayedPrefix` notice and the step
re-records on pass. Judgments are never cached.

New surface:

- config `cache`: `'off' | 'read-only' | 'read-write'` or
  `{ mode, store, dir }`. **Opt-out**: unset means `read-write`; CI forces
  read-write down to read-only; `e2e run --no-cache` overrides the config
  for one run. `store` accepts any `TraceCacheStore` implementation, so a
  shared remote cache can replace the default `.e2e/cache/` file store.
- `StepExecutorContext.replayedPrefix` (`ReplayedPrefix`,
  `ReplayHandOffReason`): the mid-step hand-off contract for executors.
- Report: agent steps carry `step.cache`
  (`self-finalized | agent-concluded | missed` + a closed reason token).
- Write settlement is attempt-scoped: passing steps stage their traces,
  confirmation requires a later passed step or a passing attempt, an
  implicated entry is evicted, and interruption touches nothing.
- Exported types: `CacheMode`, `CacheConfig`, `TraceCacheStore`,
  `CacheReadResult`, `ActionTrace`, `RecordedAction`, `TraceEntry`,
  `TraceTargetDescriptor`.

Spec: 10-determinism's "No caching" clause is replaced by the trace cache
chapter; 05-config and 16-executors document the config key and the hand-off;
`report-v1.schema.json` gains `step.cache`; conformance `suiteVersion` bumps
0.4.0 → 0.5.0 with the new `trace-1` profile.
