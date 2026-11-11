---
"@e2e-dev/web": patch
---

`web({ observationNodeBudget })` sets the node budget one observation spends, shared across the main document and its frames, default 3,000. Raise it for a known dense target whose controls fall past the default cutoff; every extra node costs capture time and payload on each observation, not model tokens (those are capped separately).
