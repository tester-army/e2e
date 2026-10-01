---
"@e2e-dev/web": patch
---

Route decisions behave like Playwright's. `route.continue()` now sends the request to the network instead of handing it to an earlier route, and still carries the configured `headers` to the app's site; the new `route.fallback()` keeps the old chaining. `continue` takes `url`, `method`, `headers`, and `postData`, with `url` checked by the same rule as `goto`, and `fulfill` takes `path` (relative to the project root) and `contentType`. An option a decision does not take, such as `abort(errorCode)` or a misspelled key, is `INVALID_ARGUMENT` instead of being ignored. `browser.waitForResponse` resolves once a matching response's headers arrive, so a slow body no longer fails the match with a timeout; `text()` and `json()` wait for the body up to the action timeout. `browser.setCookies` with a relative `url` sets the cookie on the base URL instead of failing with `ENGINE_FAILURE`.
