---
'@e2edev/agent-device': patch
---

A snapshot the iOS runner could not deliver even after agent-device restarted
it mid-request is asked for once more after a two second pause, instead of
failing the step as `APP_UNREACHABLE`. A screen whose accessibility tree is
slow to walk (a live feed re-rendering under it) has settled by then, and the
next request may restart the runner again.
