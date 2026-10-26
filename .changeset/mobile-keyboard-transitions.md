---
"@e2e-dev/mobile": patch
---

Reobserve a control after the remaining transition budget when captured keyboard state changes, even if its first bounds are unchanged. Unchanged controls keep the immediate path when keyboard state stays the same. Retry moving-target refusals only when agent-device confirms no input was dispatched.
