---
'e2e': patch
---

`agent.extract` no longer invents a value to fit the schema. The model receives the schema's shape without its value rules (`min`, `max`, lengths, patterns, formats), so a `z.number().min(100)` no longer pushes it to report 300 todos when the screen shows 3, and it can answer that the screen does not show the data: the step then fails with `ASSERTION_INCONCLUSIVE` naming what was missing, where it used to return `""` or `0`. Ask for absence explicitly (`'the phone, or null when none is shown'` with `.nullable()`) to get `null` back instead.
