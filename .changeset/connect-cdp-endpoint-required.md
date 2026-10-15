---
"@e2e-dev/web": patch
---

`web({ connect })` is `INVALID_CONFIG` at config load when `cdpEndpoint` is missing or not a function, instead of failing every attempt with `ENGINE_FAILURE: connection failed: resolve is not a function` (with `reconnectEndpoint`) or worker init with `browser connect failed: source.resolve is not a function` (without it).
