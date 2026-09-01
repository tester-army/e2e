---
'e2e': minor
---

`actionTimeout` now bounds every driver operation inside agent steps —
observations and grammar actions in both the act and judgment tiers.
Previously each in-step driver call could run to the step's remaining
deadline, so a single page that never settled could consume an entire act's
budget (observed live: one hung observation burning 581s of a 600s step).
Now such a call fails within one `actionTimeout` with a clearly attributed
error, the executor decides what to do next, and per-call `timeout` options
on production suites become unnecessary. Suites that relied on a single slow
navigation inside an act getting more than `actionTimeout` should raise
`actionTimeout` explicitly.
