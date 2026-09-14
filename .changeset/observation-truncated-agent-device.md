---
'@e2edev/agent-device': patch
---

Built against the engine contract that adds `EngineSnapshot.truncated`. The
device engine reads the whole accessibility tree it is handed, so its
snapshots never set the flag.
