---
'e2e': patch
---

`e2e explore` now uses an explicit planning mode when choosing its next
charter. A planner can schedule a destination that is not visible on the
current screen, while ordinary `agent.extract` calls continue to report
`ASSERTION_INCONCLUSIVE` instead of inventing missing data.
