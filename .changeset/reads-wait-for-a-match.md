---
"e2e": minor
---

`textContent()`, `inputValue()`, `getAttribute()`, `isEnabled()`, `isDisabled()`, `isChecked()`, and `boundingBox()` now wait for their one match until the action timeout, as actions and Playwright's reads do, instead of failing at once with `LOCATOR_NOT_FOUND` when the node is still rendering. `isVisible()`, `isHidden()`, `count()`, `all()`, and `allTextContents()` still answer from the current screen. A read of a node that never appears fails after the action timeout.
