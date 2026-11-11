---
"e2e": patch
---

`scroll_to({ text })` is faster: it reads each page once when the swipe visibly landed, instead of waiting for a second look to confirm it. A clock ticking beside a list no longer delays the end of the list: the call fails with `LOCATOR_NOT_FOUND` after a few swipes, not 800 screens later.
