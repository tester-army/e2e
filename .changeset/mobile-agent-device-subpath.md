---
"@e2e-dev/mobile": patch
---

Add the `@e2e-dev/mobile/agent-device` subpath. It exports `createAgentDeviceClient`, the error helpers, and the common types (snapshots, targets, gestures, text entry, alerts, waits) from the agent-device copy the engine uses, so custom tools can use agent-device without the project installing it separately and keeping its version in sync with this package.
