---
'@e2edev/playwright': patch
---

An exception thrown by the page inside `web.evaluate` is now a test failure,
`EVALUATE_FAILED`, carrying the page's own message, as the spec's evaluation
rules describe. It was reported as infrastructure (`BACKEND_FAILURE`, exit
code 3) with Playwright's call prefix in front of the message, so a script
that failed a check read like a broken browser. Timeouts and a document lost
to navigation keep their infrastructure classification.
