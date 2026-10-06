---
"e2e": patch
---

The replay cache key no longer carries the engine's version, so upgrading `@e2e-dev/web` or `@e2e-dev/mobile` keeps every committed recording. A recording re-finds its nodes at replay, which is where a node an engine release resolves differently is caught. Entries recorded before this release sit under the old keys: a `read-write` run records them again, and `--strict-cache` names them as `REPLAY_STALE` until it does.
