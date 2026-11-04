---
"e2e": patch
---

`scroll_to({ text })` reads each page once instead of twice. A page that reads differently from the one before and is no sparser has landed, so the agent no longer takes a second capture 75 ms later to confirm it. A page that reads the same (the scroll not rendered yet, or the end of the list) or thinner (a windowed list still drawing its rows) is still read until it holds still, and the end of a list is still `LOCATOR_NOT_FOUND`.
