---
"@e2e-dev/acp": patch
---

Fix `WORKER_CRASH (EPERM)` on Windows when an ACP session ends: a failed session directory removal no longer crashes the worker and is retried after the agent exits.
