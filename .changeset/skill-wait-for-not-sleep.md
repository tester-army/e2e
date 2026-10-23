---
"e2e": patch
---

The bundled agent skill now tells a coding agent to replace a fixed-time sleep with `agent.waitFor` on the state it was waiting for, or a matcher with a longer `timeout` when a locator names that state.
