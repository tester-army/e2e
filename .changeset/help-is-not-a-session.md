---
'e2e': patch
---

`e2e run --help`, `e2e help run`, and `e2e --version` no longer count as a completed session of that command in anonymous telemetry: the session was named before commander parsed the flags and was sent with exit code 0 once the help had printed. They send nothing now.
