---
'@e2edev/web': patch
---

`web.waitForDownload` resolves with `absolutePath` beside `path`, so a downloaded file can go straight back into `setInputFiles`.
