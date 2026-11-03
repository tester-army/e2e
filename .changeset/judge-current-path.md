---
"e2e": patch
---

`agent.assert`, `agent.waitFor`, and `agent.extract` now see the current location, so an instruction about the URL can hold or fail instead of ending inconclusive. `agent.waitFor` also judges again when only the location changed, except under `vision: 'only'`, which does not see the location.
