---
"e2e": patch
---

`scroll_to({ text })` reads each page once instead of twice. A page that reads differently from the one before and is no sparser has landed, so the agent no longer takes a second capture 75 ms later to confirm it. A page that reads the same (the scroll not rendered yet, or the end of the list) or thinner (a windowed list still drawing its rows) is still read until it holds still, and the end of a list is still `LOCATOR_NOT_FOUND`. A clock-like value on screen (`12:05`) no longer counts as a page that moved, so a list that ends with a clock ticking beside it is `LOCATOR_NOT_FOUND` instead of 800 screens later.
