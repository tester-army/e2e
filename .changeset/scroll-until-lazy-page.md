---
"e2e": patch
---

`scroll_to({ text })` keeps paging a list that appends when it reaches the end. An unchanged screen is re-read for a second before it counts as stopped, so that pause is not `LOCATOR_NOT_FOUND`.
