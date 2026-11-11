---
"@e2e-dev/mobile": patch
---

Cancel pending agent-device press requests when their caller is interrupted or the adapter stops waiting for a response. This stops native readiness polling after a failed step while preserving the existing minimum 250 ms acknowledgement allowance and possibly-committed timeout behavior.
