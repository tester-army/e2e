---
"@e2e-dev/mobile": patch
---

Add the unstable `device.unstable_raw`, which may change or go away in any release: the test's agent-device session name, the device's id and name, and an agent-device `client` bound to that session, for what the `device` methods don't cover. Client calls aren't recorded as steps, replayed from the agent cache, or redacted.
