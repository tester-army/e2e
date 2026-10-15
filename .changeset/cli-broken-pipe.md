---
"e2e": patch
---

Piping CLI output into a reader that stops early, such as `e2e --help | head -1`, no longer crashes with an EPIPE stack trace. The command finishes quietly with its usual exit code, and `e2e run` still tears down and writes its report.
