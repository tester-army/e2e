---
'@e2edev/e2e': patch
---

Replayed trace actions carry the test origin. A replay executes recorded actions with no model reading the screen after them, only its own relocation, which polls; so an engine treats them as deterministic steps. On the device engine that removes the settle wait from every replayed action.
