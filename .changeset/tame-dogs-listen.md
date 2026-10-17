---
'@e2e-dev/mobile': patch
---

Keep healthy engine sessions open on leased devices across worker replacement. After a failed test, a retired worker could drop the device claim. A competing session could then take the device and make later tests fail with "Device is already in use".

Forced worker shutdown still closes the engine session. Before the next attempt, the engine resets an agent-device recording whose stop is unconfirmed. This reset and `device.closeApp()` close the session and drop the device claim during the run.

At run end, the engine closes its sessions and the provider releases its device leases.

Before another attempt on the same worker, retry a provider recording whose stop failed. Wait for that stop to finish before starting the attempt, and keep its original artifact directory. The worker also retries cleanup at attempt end and disposal while it owns the recording handle. Providers remain responsible for any external recording cleanup when releasing a lease at run end. Closing an agent-device session cannot guarantee that a cloud recording stops.
