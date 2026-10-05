---
'@e2e-dev/web': patch
---

`browser.evaluate` evaluates a string as an expression: `browser.evaluate('document.title')` and `browser.evaluate('(() => document.title)()')` return the title instead of failing with `EVALUATE_FAILED: ... is not a function`. A string that evaluates to a function, such as `'() => document.title'`, is still called with the argument.
