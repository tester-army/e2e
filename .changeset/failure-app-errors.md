---
"e2e": patch
---

A failed test's block in the terminal and in `summary.md` quotes the first 3 errors the app logged (console errors, uncaught exceptions, failed requests, 5xx responses), so an app error behind a locator failure shows without opening `trace.md`.
