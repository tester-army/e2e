---
'e2e': patch
---

Importing the removed `createAgent` from `e2e/agent` fails with a `CONFIG_LOAD_FAILED` that names the replacement, the options written as the agents entry itself (`agents: { default: { model, system, tools } }`), instead of the bare ESM missing-export error.
