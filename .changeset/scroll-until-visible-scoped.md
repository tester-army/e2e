---
'e2e': minor
---

`scrollUntilVisible` on a locator swipes that node instead of the viewport, so a feed or a table that is its own scroll container pages without the pointer having to hover it first: `screen.getByRole('feed').scrollUntilVisible(row)`. It takes `momentum` for the stride of each step (`'none'`, `'slow'`, `'fast'`; `'slow'` unless told otherwise), and an option it does not take is `INVALID_ARGUMENT` before any swipe, as on the other actions.
