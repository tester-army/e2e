---
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

`locator.filter()` takes `hasNot`, which drops matches whose subtree resolves a locator, as in Playwright. Third-party engines must handle the new `hasNot` field of a `filter` expression.
