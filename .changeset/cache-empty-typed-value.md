---
"e2e": patch
---

A recorded step that types an empty value, which clears a field, replays instead of failing with `REPLAY_STALE` (`invalid-entry`). The cache wrote the entry but its reader rejected the empty `type` or `typeText` value, so such a step could never replay from a recording.
