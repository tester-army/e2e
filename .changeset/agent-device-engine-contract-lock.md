---
"@e2edev/agent-device": minor
---

Breaking: follows the reshaped engine contract. Observations carry one `root` node (role `screen`, id `root`) over the device's windows and a `location` of the form `<app> / <screen title>` instead of an `app://` URL. Nodes carry `testId` from the accessibility identifier or resource id; the harness's `testIdAttribute` is gone. The engine declares the action kinds a device honors, so the agent is no longer offered `select` on a device. `press` accepts `Enter`, `Space`, and single characters; anything else fails with `UNSUPPORTED_CAPABILITY`. A discovered device pool reaches the workers through the `prepare` result's `env` instead of a write to the run's environment.
