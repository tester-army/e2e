---
"e2e": patch
---

Stop printing the one-time telemetry notice before `e2e init`; the first command after the scaffold prints it instead.

`e2e init` lists the planned file changes one per line before asking to apply them, instead of joining them into one sentence.
