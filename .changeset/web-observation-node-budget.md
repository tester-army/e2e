---
"@e2e-dev/web": patch
"e2e": patch
---

`web({ observationNodeBudget })` sets the node budget one observation spends, shared across the main document and its frames, default 3,000. Raise it for a known dense target whose controls fall past the default cutoff; every extra node costs tokens on each observation.
