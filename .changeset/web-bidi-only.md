---
"@e2e-dev/web": minor
---

**Breaking:** the web engine drives Chromium and Firefox over WebDriver BiDi and no longer uses Playwright. Tests, fixtures, and `web()` options stay the same, except:

- WebKit is gone: `web({ browser: 'webkit' })` is `INVALID_CONFIG`.
- `surfaceOf` and `PlaywrightLiveSurface` are removed, so there is no raw Playwright `Page` or `BrowserContext` to reach for.
- `browser.locator` takes CSS or XPath only: no `>>` chains or `text=` and `nth=` engines. Chain `nth()` and screen queries instead.
- `connect.reconnectEndpoint` and `BrowserLease.reconnectEndpoint` are removed, and `reconnectEndpoint` in `connect` is `INVALID_CONFIG`: a dropped connection fails the attempt, and the next attempt attaches again through `cdpEndpoint`.
- With a `scope: 'attempt'` browser provider, `app.clearState()` and saved sessions throw `UNSUPPORTED_CAPABILITY`: the attempt runs in the fresh browser's own context.
- `setInputFiles` on a browser provider's browser throws `UNSUPPORTED_CAPABILITY`, and so does a download on a provider without `downloads`.
- Browsers are new pinned builds: Chrome for Testing 157.0.8103.38 (the headless shell, or full Chrome when headed) and Firefox 159.0.1. They install into `E2E_BROWSERS_PATH`, else `e2e/browsers` in the user cache, with `npx @e2e-dev/web install [chromium|firefox] [--with-deps] [--headed]`, or on the first run. `PLAYWRIGHT_BROWSERS_PATH` is no longer read.
- Chromium video needs an ffmpeg with VP9: `E2E_FFMPEG_PATH`, else `ffmpeg` on the `PATH`, else a pinned build the first recording downloads into the browser cache (`npx @e2e-dev/web install ffmpeg` fetches it ahead). A run that records no video never downloads it. Windows on Arm has no pinned build: set `E2E_FFMPEG_PATH` there.
- The old `ms-playwright` browser cache is no longer used and can be deleted.
- Every browser and ffmpeg archive is checked against a pinned SHA-256 before it is unpacked. `E2E_BROWSERS_DOWNLOAD_HOST` names an `https` mirror (plain `http` only on `localhost`) serving the Chrome for Testing, Mozilla archive, and ffmpeg-static paths. Downloads honor `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` (on Node 22, with `NODE_USE_ENV_PROXY=1`).
- Concurrent installs into one cache wait for each other and say so; one whose owner died or stopped responding is taken over. Ctrl-C or SIGTERM during `e2e-web install` stops the download, removes the partial files, and exits 130 or 143. On Linux, `--with-deps` also installs `xz-utils`, which unpacking Firefox needs.
