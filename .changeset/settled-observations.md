---
'@e2edev/e2e': patch
---

Executor-facing observations always settle. Every `observe()` an executor
makes re-observes until the page shape holds still (75 ms poll, 1 s ceiling —
one shared loop with replay's pre-action wait), so the executor never reads a
snapshot the app is still reacting to. Before this, a fetch-backed mutation
could hand a fast model a pre-render observation: the model would repeat the
action — double-toggling the state it had just set — and then judge the step
on equally stale evidence, reporting a pass the deterministic assertion after
it correctly failed. Observed live on the bench (`gemini-3-flash`, the
approve-expense flow) and fixed by this settle. Replay still reads raw
observations and does its own settling through the same shared loop.
