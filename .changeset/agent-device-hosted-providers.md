---
'@e2edev/agent-device': minor
---

`agentDevice({ device })` accepts a `DeviceProvider`: an object that leases one hosted device per worker slot when the run starts and releases every lease when it ends. The engine drives each lease through the agent-device daemon the lease names (`daemon.baseUrl`, `daemon.authToken`) instead of the local one, selects `device` inside it when given, and skips its own `appPath` install when the lease reports `installedApp`. Slots lease in parallel; a slot that fails releases the others and ends the run before any test. No vendor ships in the package; the mobile guide shows an Expo EAS Simulator provider as user code. `DeviceProvider`, `DeviceRequest`, `DeviceLease`, and `DeviceReleaseContext` are exported.
