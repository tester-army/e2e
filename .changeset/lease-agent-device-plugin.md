---
'@e2e-dev/mobile': patch
'@e2e-dev/testmu': patch
---

`@e2e-dev/mobile/lease` adds `agentDevicePlugin(entry)`, which checks a provider plugin's version against the engine's agent-device and registers it in a lease daemon's home; `@e2e-dev/testmu` now uses it and needs `@e2e-dev/mobile` 0.12.8 or later. A lease's `device` selector is used to allocate it and no longer goes on the worker's client, since the lease scope already picks the device.
