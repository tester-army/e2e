---
"@e2e-dev/web": patch
---

Two failures caused by the test or the page no longer report as `ENGINE_FAILURE`:

- A `browser.goto` whose request a route aborted fails with `ACTION_FAILED`. When the route aborted it because the handler threw, such as a `route.fulfill` with an invalid header, the `goto` fails with the handler's error.
- `app.screenshot()` taken while the page navigates captures the document showing, masked.

A closed page or browser is still `ENGINE_FAILURE`.
