---
"@e2edev/playwright": patch
---

Replace the keyed browser pool with a single shared connection per worker, preserving reconnect and in-flight launch cleanup.
