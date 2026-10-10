---
"e2e": patch
---

Stop surviving app-command descendants on POSIX even when the command leader exits first, preserving the shutdown grace period for the entire process group.
