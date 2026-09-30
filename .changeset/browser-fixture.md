---
'@e2e-dev/web': minor
'e2e': minor
---

Breaking: the web engine's fixture is `browser`, not `web`: `test('...', async ({ screen, browser }) => { await browser.goto('/') })`, `expect(browser).toHaveURL('/')`, and `requires: ['browser']`. The `Web` type is now `Browser` and `WebExpectation` is `BrowserExpectation`; the `web()` engine factory and the other `Web*` types keep their names. Destructuring `web` fails with `UNSUPPORTED_CAPABILITY` naming `browser`, and recorded steps read `browser.goto` and the rest.
