---
"e2e": patch
---

`--strict-cache` now fails a step with `REPLAY_STALE` when the cache directory holds its recording under another key, for example after an `e2e` or engine upgrade or a change to the agent's context. Before, such a step ran live and spent model calls with no error. The message names the old entry file. A step with no recording still runs live.
