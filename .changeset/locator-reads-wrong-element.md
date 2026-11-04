---
'e2e': minor
'@e2e-dev/web': patch
---

**Breaking:** `inputValue()` on a node with no value, such as a heading or a button, and `isChecked()` on a node with no checked state throw `ACTION_FAILED`, as in Playwright, instead of returning `""` and `false`. A field with no value still reads `""`, and a checkable role with no state reported still reads `false`. `uncheck()` on an ARIA `role="radio"` now clicks it, as in Playwright; a native radio still refuses.
