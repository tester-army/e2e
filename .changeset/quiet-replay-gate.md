---
"e2e": minor
---

Add `cache.replayOnly` and `e2e run --replay-only` for runs that require complete recorded agent actions without resolving models or invoking executors. The mode implies strict and read-only caching, replays on retries, and fails missing or non-replayable recordings and judgment methods with `REPLAY_MISSING`. Use deterministic assertions to verify replayed actions.

Replay-only gates `e2e run` tests only, so `cache.replayOnly` in the config leaves `e2e explore` and `e2e mcp` sessions on the model. A partial replay that replay-only or `cache.strict` stops reads as stopped in trace pages and counts as missed, not handed off.
