---
"@e2e-dev/web": patch
---

Experimental WebDriver BiDi driver for chromium and firefox: `web({ driver: 'bidi' })`, or `E2E_WEB_DRIVER=bidi` to switch a whole run. It takes the same options and fixtures as the Playwright driver: observation, locators, actions, frames, routes, `waitForResponse`, dialogs, downloads, saved sessions, video, headers, basic auth, emulation, permissions, and `connect` or a worker-scoped browser provider on chromium. Not yet: a persistent remote context (`connect.reconnectEndpoint`, provider scope `attempt`). On firefox, `browser.emulateMedia` and HTML5 drag and drop wait on Firefox support. Playwright stays the default.
