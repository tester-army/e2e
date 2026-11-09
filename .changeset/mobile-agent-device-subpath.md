---
"@e2e-dev/mobile": patch
---

Custom tools can now call agent-device without their own `agent-device` dependency. `deviceSession()` from `@e2e-dev/mobile/tools` returns the running attempt's session and client, and `@e2e-dev/mobile/agent-device` re-exports agent-device's types and error helpers. Both are unstable, like `device.unstable_raw`.
