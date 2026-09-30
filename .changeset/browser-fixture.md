---
'@e2e-dev/web': minor
'e2e': minor
---

Breaking: the web engine's fixture is `browser`, not `web`: `test('...', async ({ screen, browser }) => { await browser.goto('/') })`, `expect(browser).toHaveURL('/')`, and `requires: ['browser']`. The `Web` type is now `Browser`, `WebExpectation` is `BrowserExpectation`, `WebRoute` is `BrowserRoute`, and `WebResponse` is `BrowserResponse`; the `web()` engine factory and the `WebOptions` family keep their names. Recorded steps read `browser.goto` and the rest. A leftover `requires: ['web']` skips the test on every web target: rename it to `requires: ['browser']`.
