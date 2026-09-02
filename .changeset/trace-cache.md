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

A replay never passes on mechanics alone: each entry records the state the
step passed in — the end path and the **end anchors**, the elements that
appeared between the step's first observation and its passing one — and a
full replay self-finalizes only while that state is on screen again. A flow
whose actions all ran but whose effect is missing hands off with
`end-mismatch`, and the built-in agent is told to verify before acting. If the
agent then has to act further to pass, the entry is evicted rather than
re-staged with the failed flow plus its repair; a hand-off the agent settles
without acting heals the anchors in place.

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
  confirmation requires a later passing **verification step** (an `expect`
  assertion, a locator `waitFor`, `agent.assert`, or `agent.waitFor`) — a
  later `agent.act` or the attempt passing on its own confirms nothing — an
  unconfirmed entry is evicted, and interruption touches nothing.
- Exported types: `CacheMode`, `CacheConfig`, `TraceCacheStore`,
  `CacheReadResult`, `ActionTrace`, `RecordedAction`, `TraceEntry`,
  `TraceTargetDescriptor`.

Spec: 10-determinism's "No caching" clause is replaced by the trace cache
chapter; 05-config and 16-executors document the config key and the hand-off;
`report-v1.schema.json` gains `step.cache`; conformance `suiteVersion` bumps
to 0.8.0 with the `trace-1` profile, including `TRACE-ANCHOR-001` and the
verification-step write rule.
