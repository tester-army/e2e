---
"@e2e-dev/web": patch
"e2e": patch
---

A `web()` target takes `app.permissions` with `'grant'` states, granted to every page of the attempt: `permissions: { 'clipboard-read': 'grant', 'clipboard-write': 'grant' }` lets the app use the clipboard in headless Chromium. Names are checked against the browser's at config load; `'deny'` and `'reset'` are refused on web.
