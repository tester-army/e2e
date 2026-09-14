---
"e2e": patch
---

`e2e init` no longer writes `agent-device` next to `@e2edev/agent-device`, since the engine installs it. A project that already declares `agent-device` keeps it.
