---
"@e2edev/e2e": minor
---

The `list` reporter's summary gains a `Cache` row under `AI` with the trace
cache's part in the run, counted by agent step: `9 replayed · 2 handed off ·
4 missed`. A replayed step ran whole from its recorded actions with no model
turn, a handed-off step replayed a prefix before the model took over, and a
missed step had no usable entry. Zero counts are left out, so a cold cache
reads `Cache  20 missed`; a run with the cache off has no row.
