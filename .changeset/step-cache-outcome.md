---
"e2e": minor
---

A step's `cache` detail in the report now says what the attempt did to its recording once it settled: `outcome` is `written`, `kept`, or `evicted`, and `outcomeReason` says why an entry was kept (`confirmed`, `unchanged`) or evicted (`repaired`, `failed-after-replay`, `not-replaced`, `unconfirmed`). Both are optional and appear only in `read-write` mode when the attempt changed or confirmed an entry, so a self-healing CI loop can find the tests a second pass would re-record without diffing `.e2e/cache/` against git.
