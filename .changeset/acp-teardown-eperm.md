---
"@e2e-dev/acp": patch
---

Fix `WORKER_CRASH (EPERM)` on Windows when an ACP session tears down: the session directory is now removed only after the agent process exits, with retries for transient locks, and a failed removal never throws.
