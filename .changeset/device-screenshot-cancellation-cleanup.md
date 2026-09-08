---
"@e2edev/agent-device": patch
---

Remove temporary raw screenshots after device capture finishes, including
captures that outlive a timeout or cancellation. Each capture owns a separate
temporary directory, and the next attempt waits for its cleanup.
