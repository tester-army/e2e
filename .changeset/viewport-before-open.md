---
'@e2e-dev/web': patch
---

`web.setViewport` works before the first navigation, as Playwright's `setViewportSize` does, instead of failing with `APP_NOT_OPEN`. The next `app.open` loads at that size, so a phone-sized test never renders the desktop layout first. The size also holds through `app.restart()` and `app.clearState()`.
