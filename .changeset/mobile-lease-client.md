---
'@e2edev/mobile': minor
---

A `DeviceLease` can carry `client`: agent-device client configuration the worker's client is created with, next to the `daemon` address, which becomes optional. A daemon that runs agent-device's own device-cloud runtimes resolves a hosted device from the lease scope on each command (`tenant`, `runId`, `leaseId`, `leaseBackend`, `leaseProvider`), and a `stateDir` reaches a daemon the provider started, so such a provider returns what `leases.allocate` gave it and no longer needs a daemon address or a proxy that stamps the scope onto requests. `session`, `daemonBaseUrl`, and `daemonAuthToken` stay with the engine and `daemon`; a lease setting them is refused. `DeviceClientConfig` and `DeviceConnection` are exported; the mobile guide shows a provider on a device cloud.
