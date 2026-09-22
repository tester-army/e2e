---
'e2e': patch
---

A judgment explanation is measured in code points, the unit `maxLength` counts in `schema/agent-judgment-v2.schema.json`. An explanation with emoji or other astral characters that the schema accepts was rejected by the runner, which counted UTF-16 units.
