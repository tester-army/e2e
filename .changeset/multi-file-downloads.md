---
"@e2e-dev/web": patch
---

Add `browser.waitForDownloads(trigger, { count })` to collect several files from one trigger. `waitForDownload` now also bounds completion and saving by its timeout.
