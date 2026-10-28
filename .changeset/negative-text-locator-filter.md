---
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

`locator.filter()` takes `hasNotText`, which drops matches whose text contains a string or matches a RegExp, as in Playwright. Third-party engines must handle the new `hasNotText` field of a `filter` expression.
