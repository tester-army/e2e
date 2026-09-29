---
'@e2e-dev/web': patch
'@e2e-dev/kernel': patch
---

`web.waitForDownload` works on a Kernel browser. It failed with `download failed: download.saveAs: canceled` on every hosted browser, which saves a download to its own disk. A `BrowserProvider` can now implement `downloads: { dir, read }`: the engine has the browser save under `dir` on its machine and reads the finished file back through `read`. `kernel()` implements it with Kernel's browser filesystem API. On a provider without it, a failed download names the provider and the missing `downloads`.
