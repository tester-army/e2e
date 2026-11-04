---
"e2e": patch
"@e2e-dev/web": patch
---

A call's `timeout: 0` now means no deadline of its own, as in Playwright: locator actions, `waitFor`, matchers, `toHaveScreenshot`, `expect.poll`, contributed fixture calls, and `browser.goto`, `waitForResponse`, and `waitForDownload` wait until the test timeout (`cleanupTimeout` in `afterEach`) instead of failing at once or being refused. A negative, `NaN`, or infinite `timeout` is `INVALID_ARGUMENT` on every call, locator actions included (`INVALID_CONFIG` on `expect.poll`, as before). `expect.poll` with `timeout: 0` outside a test is `INVALID_CONFIG`. Engine authors get `stepTimeout` from `e2e/engine` to give a contributed call's `timeout` option the same rules.
