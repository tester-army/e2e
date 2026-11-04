---
"e2e": patch
---

Fail `e2e run` when an app command exits unexpectedly after readiness.
Report its exit code or signal and redacted log tail, and stop queued tests.
