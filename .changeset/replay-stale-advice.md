---
'e2e': patch
---

`REPLAY_STALE` names what turned strict on and where the entry lives: `without --strict-cache`, `with cache.strict set to false`, or both, and the configured `cache.dir` relative to the project (or the configured `cache.store`). It used to say `without --strict-cache` and `.e2e/cache` whatever the config set.
