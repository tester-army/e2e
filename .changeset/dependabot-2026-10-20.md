---
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/smol": patch
---

Update dependencies: the web engine drives Playwright 1.64.1 (and the Chromium it installs), and smol machines boot the matching `mcr.microsoft.com/playwright:v1.64.1-noble` image. The runner moves to `oxc-parser`, `oxc-transform`, and `@oxc-project/runtime` 0.154.0, `@vitest/expect` 5.0.5, and `@ai-sdk/provider` 4.0.28.
