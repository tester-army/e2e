---
'@e2e-dev/mobile': patch
'@e2e-dev/limrun': patch
---

Device-cloud leases are allocated and renewed under a named agent-device session, so a newer agent-device that refuses a provider lease to an unnamed client keeps working with BrowserStack, TestMu AI, and Limrun.
