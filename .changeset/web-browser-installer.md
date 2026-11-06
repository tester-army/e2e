---
"@e2e-dev/web": patch
---

Browsers install without `@puppeteer/browsers`, into the same cache layout, so builds already installed are found. `E2E_BROWSERS_DOWNLOAD_HOST` downloads from a mirror that serves the Chrome for Testing and Mozilla archive paths. Ctrl-C or SIGTERM during `e2e-web install` stops the download, removes the partial files, and exits 130 or 143. On Linux, `--with-deps` also installs `xz-utils`, which unpacking Firefox needs.
