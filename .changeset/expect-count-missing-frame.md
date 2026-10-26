---
"e2e": patch
---

`toHaveCount` and the list forms of `toHaveText` and `toContainText` read a locator under a missing frame as zero matches, so `toHaveCount(0)` passes after an iframe closes instead of failing with `LOCATOR_NOT_FOUND`.
