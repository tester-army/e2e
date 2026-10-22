---
'@e2e-dev/testmu': patch
---

Clarify the allocation error when agent-device does not acknowledge `retainOnClose`. The message explains that closing the engine session could end the TestMu AI lease before the provider releases it.
