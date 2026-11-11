---
"@e2e-dev/mobile": patch
---

Cancel pending agent-device press requests when their caller is interrupted or their input budget expires. A press waiting for native readiness can no longer dispatch after the step has ended. Inputs that already dispatched keep their existing possibly-committed timeout behavior.
