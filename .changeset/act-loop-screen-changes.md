---
'@e2edev/e2e': minor
---

The built-in agent reads action results after their effect and sends screen changes instead of whole screens.

- After a tap, type, press, select, or navigate, the next observation waits, bounded to two seconds, for the screen to leave the shape the action was resolved against. A tap on a link reports the page it opened rather than the page it left; an action that changed nothing says so instead of returning a stale screen. Cached replays settle through the same wait.
- Every action result and every `observe` after the opening screen reports only the lines that changed, keyed by the stable node ids and prefixed `added`, `changed` (with what the line read before), or `removed`. A node that only moved to another depth is not reported, and a screen cut at the observation byte limit reports no removals, since the nodes past the limit were left out rather than gone. A screen that changed mostly goes out whole again, and the full screen it replaced is elided, so the transcript prefix stays stable for prompt caching.
- Clock-like text (`12:05`, `0:59:59`) is ignored when comparing screen shapes, so a ticking timer neither ends the wait for an action's effect nor keeps a screen from settling.
- Several actions may be issued in one turn; they run in order and each reports its own changes. A failed action returns the failure with the current screen, so a stale id costs no extra turn.
- `complete_step` accepts summaries up to 2000 characters instead of rejecting them past 500, and asks for a short handoff for the next step.
- The prior-step ledger shows a replayed step's recorded verdict without the cache replay notice.
- A targeted grammar action (tap, type, press, select, scroll, secret fill) is bounded by the smaller of `actionTimeout` and 15 seconds, so a tap blocked by an overlay reports what is in the way within seconds instead of sitting in the engine's actionability retry for the whole `actionTimeout`. Navigation keeps the full budget.
- Engine errors thrown by an engine loaded from a config file are recognized structurally: a retryable stale-node race during an observation is re-read instead of failing the action, and step events record the engine code (`NODE_STALE`, `NOT_ACTIONABLE`) instead of `EngineError`.
