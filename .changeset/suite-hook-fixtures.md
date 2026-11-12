---
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/html-reporter": patch
---

`beforeAll` and `afterAll` now receive `app`, `screen`, and the engine's fixture (`device` on `@e2e-dev/mobile`, `browser` on `@e2e-dev/web`), so per-describe setup such as `device.setPermission()` or `device.clearKeychain()` no longer has to go in `beforeEach`. The hooks of a scope run on a hook attempt of their own that starts at the first fixture call, so a hook that only seeds a database starts nothing; in a serial group they run on the group's session. `agent` and `test.extend()` fixtures stay per test. A `HOOK_FAILED` whose cause is the engine (a hook attempt that could not start) is now an `infrastructure` error with exit code 3, and a hook that returns while a step is still running fails with `HOOK_FAILED`.
