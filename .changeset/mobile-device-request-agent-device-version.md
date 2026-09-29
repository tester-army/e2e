---
"@e2e-dev/mobile": minor
---

A `DeviceProvider`'s `acquire` request carries `agentDeviceVersion`, the agent-device version the engine's client speaks, so a provider for a service that starts the daemon can start the same version. `@e2e-dev/eas` sends it to EAS Simulators, which otherwise runs the latest agent-device.
