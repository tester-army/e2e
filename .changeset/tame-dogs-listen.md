---
'@e2e-dev/mobile': patch
---

Keep healthy agent-device sessions open on leased devices across worker replacement. After a failed test, a retired worker could close its session. Another session could then take the device and make later tests fail with "Device is already in use".

Forced worker shutdown can still close the agent-device session. `device.closeApp()` and a reset after an unconfirmed agent-device recording stop also end that session. Another session can then take the device. The provider lease stays held until run end.

The engine retries failed provider recording stops before another attempt on the same worker. Recovery is cleanup-only. Cleanup retries do not add returned video segments to reports, and recovery does not clear a required-video cleanup failure. Providers must clean up external recordings when releasing leases at run end.
