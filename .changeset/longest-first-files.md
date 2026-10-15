---
"e2e": patch
---

With more than one worker, `e2e run` starts the files that took longest in the previous run first, so a slow file no longer starts last and holds the run open after the other workers finish.
