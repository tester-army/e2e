---
"@e2e-dev/web": patch
---

Allow `browser.waitForResponse` before the first `browser.goto` or `app.open`. The wait and navigation share the attempt's active page, so the first navigation response can be observed without opening a page beforehand.
