---
"e2e": patch
---

Fail `e2e run` when an app command exits unexpectedly after readiness.
Report its exit code or signal and redacted log tail.
Interrupt active tests and skip queued tests only for targets that depend on that command.
Ignore command exits after those targets finish their work.
An exit with code 0 also fails the run, so a command that starts the app in the background and then exits, such as `docker compose up -d --wait`, now fails.
Keep the app in the foreground instead, for example `docker compose up` without `-d`.
