---
'@e2edev/e2e': minor
---

`prepare` may return `{ workers }`: the worker cap the engine actually provisioned for the target, `1` to `info.slots`, for engines that only learn their capacity at run time (a device pool discovered from the booted devices). The scheduler honours it over the declared `workers`.
