---
"e2e": patch
---

`locator.setInputFiles([])` clears a file input and fires `input` and `change`, as in Playwright. It used to throw `INVALID_ARGUMENT`. A blank path is still refused.
