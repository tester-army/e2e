---
"e2e": patch
---

Fail `e2e run` when an app command exits unexpectedly after readiness.
Report its exit code or signal and redacted log tail.
Interrupt active tests and skip queued tests only for targets that depend on that command.
Ignore command exits after those targets finish their work.
