---
'e2e': minor
---

`agents.<name>.timeout` is the judgment budget: the deadline of one `assert`, `waitFor`, or `extract` call, 30 s by default. Until now that deadline was `max(30000, actionTimeout)`, so a project with a slow judge had to inflate the engine's per-operation budget to buy the model time, and every navigation and actionability wait inherited the inflated number. `actionTimeout` bounds engine operations only. A suite that raised `actionTimeout` for the judge should move the value to the agent; one that raised it for a slow page keeps it.
