---
"@e2edev/e2e": minor
---

A step in a retry attempt reports how the cache took part instead of
nothing: `step.cache` (and `ActResult.cache`) reads `missed` with the new
reason `retry`, since a retry records a trace but never replays one. Before,
such a step was indistinguishable from one that ran with caching off. The
report schema's `reason` enum gains the value.
