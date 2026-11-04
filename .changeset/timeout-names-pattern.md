---
"e2e": patch
"@e2e-dev/web": patch
---

A fixture call that times out names what it waited for: `browser.waitForResponse('foo.css')` fails with `operation timed out in browser.waitForResponse "foo.css"`. Steps for `waitForURL`, `waitForResponse`, `route`, and `unroute` show a string pattern in quotes and a RegExp as its literal.
