---
"@e2edev/agent-device": minor
---

`agent-device` is a dependency of this package again, pinned to the exact version the engine was built and tested against (`0.21.1`); the `0.21.x` peer requirement from 0.7.0 is gone, and the pin moves with each engine release. A project that added `agent-device` to satisfy the peer can drop it. A project that also drives devices through the agent-device CLI keeps its own copy; keep its version in step with the pin, so one agent-device runs, not two.
