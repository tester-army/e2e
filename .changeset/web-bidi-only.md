---
"@e2e-dev/web": minor
---

**Breaking:** the web engine drives Chromium and Firefox over WebDriver BiDi and no longer uses Playwright. Tests, fixtures, and `web()` options stay the same, except:

- WebKit is gone: `web({ browser: 'webkit' })` is `INVALID_CONFIG`.
- `surfaceOf` and `PlaywrightLiveSurface` are removed, so there is no raw Playwright `Page` or `BrowserContext` to reach for.
- `browser.locator` takes CSS or XPath only: no `>>` chains or `text=` and `nth=` engines. Chain `nth()` and screen queries instead.
- `connect.reconnectEndpoint` is `INVALID_CONFIG`: a dropped connection fails the attempt, and the next attempt attaches again through `cdpEndpoint`.
- Every attempt runs in a browser context of its own, also on a `scope: 'attempt'` provider's browser, so cookies and storage that `smol({ prepare })` leaves in the browser no longer reach tests. Use sessions instead.
- `setInputFiles` on a browser provider's browser throws `UNSUPPORTED_CAPABILITY`, and so does a download on a provider without `downloads`.
- Browsers are new pinned builds: Chrome for Testing 157.0.8103.38 (the headless shell, or full Chrome when headed) and Firefox 159.0.1. They install into `E2E_BROWSERS_PATH`, else `e2e/browsers` in the user cache, with `npx @e2e-dev/web install [chromium|firefox] [--with-deps] [--headed]`, or on the first run. `PLAYWRIGHT_BROWSERS_PATH` is no longer read.
- Chromium video needs an ffmpeg with VP9: `E2E_FFMPEG_PATH`, else `ffmpeg` on the `PATH`, else a pinned download into the browser cache.
