---
"@e2e-dev/web": patch
---

A headless run no longer downloads the full Chromium when the headless shell is installed, and the install no longer removes other browsers in the cache. Set `PLAYWRIGHT_SKIP_BROWSER_GC=0` to restore cleanup.
