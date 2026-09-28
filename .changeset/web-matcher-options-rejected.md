---
'@e2e-dev/web': patch
---

`expect(web).toHaveURL`, `toHaveTitle`, `toHaveClass`, and `web.waitForURL` refuse an option other than `timeout` with `INVALID_ARGUMENT` instead of ignoring it, so Playwright's `ignoreCase` on `toHaveURL` or `waitUntil` on `waitForURL` no longer runs as if absent.
