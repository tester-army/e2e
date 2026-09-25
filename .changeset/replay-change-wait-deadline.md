---
"e2e": patch
---

Count screen capture time and delays after an action toward its wait for a visible change. A slow mobile capture or a later observation no longer starts that wait again. The following screen stability check remains in place, and empty navigation captures without screenshot evidence keep polling within its window.
