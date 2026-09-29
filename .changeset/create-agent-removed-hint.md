---
'e2e': patch
---

A config that still imports `createAgent` from `e2e/agent` fails with `CONFIG_LOAD_FAILED` naming the replacement, writing its options as the `agents` entry itself, instead of the loader's bare missing-export message.
