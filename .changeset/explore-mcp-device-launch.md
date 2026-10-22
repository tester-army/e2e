---
"e2e": patch
---

`e2e explore` and the MCP `open_session` now launch a device target's pinned app before their first observation, as a test's `app.open()` does. They no longer depend on the engine's warm-up having opened it, which it skips for a target with an `app.appPath`, and used to fail with `APP_NOT_OPEN`.
