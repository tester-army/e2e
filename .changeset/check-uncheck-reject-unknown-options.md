---
'e2e': patch
---

`check()` and `uncheck()` reject an option they do not take with `INVALID_ARGUMENT`, as `tap()` and `click()` already do. Before, a JavaScript test passing Playwright's `{ trial: true }` had the option ignored and the box really toggled, change events and all.
