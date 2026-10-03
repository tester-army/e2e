---
"e2e": patch
---

`--strict-cache` now fails a step with `REPLAY_STALE` when its recording is in the cache directory under an older key, for example after an `e2e` or engine upgrade or a change to the agent's context. Before, such a step ran live and spent model calls with no error. The message names the old entry file to delete after you re-record. A step with no recording still runs live.
