---
'e2e': patch
---

`e2e init` runs faster: planning the agent skill install stats each path once, skips reads for a skill directory that does not exist, and init no longer loads zod, or the wordmark when there is no terminal.
