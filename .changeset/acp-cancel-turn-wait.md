---
'@e2e-dev/acp': patch
---

A step that times out while the agent is still finishing the previous step's turn now fails with its timeout instead of `MODEL_PROVIDER_FAILED`.
