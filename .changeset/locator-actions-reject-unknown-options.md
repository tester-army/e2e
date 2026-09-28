---
'e2e': patch
---

Every locator action rejects an option it does not take with `INVALID_ARGUMENT` before the node resolves, as `tap()` and `click()` already did. Before, `check()`, `uncheck()`, `fill()`, `press()`, `selectOption()`, `hover()`, and the other timeout-only actions ignored the key: a JavaScript test passing Playwright's `{ trial: true }` really toggled the box, change events and all.
