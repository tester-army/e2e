---
"@e2e-dev/web": patch
---

Keep a Playwright timeout an `OPERATION_TIMEOUT` when its call log mentions a detached element or a navigation, instead of reporting a retryable `NODE_STALE`.
