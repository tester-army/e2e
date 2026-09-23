---
'e2e': patch
---

An `EngineError` thrown by a contributed fixture method (`device.foregroundApp()` after `device.closeApp()`, for one) is mapped onto the runner taxonomy the way every other engine surface's is: `INVALID_STATE` is `APP_NOT_OPEN`, `OPERATION_TIMEOUT` is `ACTION_FAILED`, `UNSUPPORTED_CAPABILITY` and `ENGINE_FAILURE` keep their codes. The fixture recorder let the engine code through untranslated, so a test read `INVALID_STATE` where the reference promised `APP_NOT_OPEN`. Errors that are not `EngineError`s are rethrown as the fixture threw them.
