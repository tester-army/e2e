---
"@e2e-dev/web": patch
---

Add `attachBrowser(cdpEndpoint, options?)`: `browser` and `screen` on a running Chromium's open tab in its default context, outside a test. `close()` detaches and leaves the browser, the tab, and its cookies and storage as they were. Requires e2e 0.23.1 or newer.
