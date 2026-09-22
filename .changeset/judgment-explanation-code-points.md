---
'e2e': patch
---

A judgment explanation is measured in code points, the unit `maxLength` counts in `schema/agent-judgment-v2.schema.json`. An explanation with emoji or other astral characters that the schema accepts was rejected by the runner, which counted UTF-16 units.

An `agent.assert` whose repair round is rejected as well fails `MODEL_OUTPUT_INVALID` with the rejection as the step's `explanation`, and both rejected answers are `schema` events on the step. The report used to omit the explanation there, which `schema/report-v1.schema.json` requires on a judgment step once a model call was made, so the runner wrote a report its own schema rejected.
