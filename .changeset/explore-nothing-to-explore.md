---
"e2e": patch
---

`e2e explore --changed-since` can skip a change no user can see, such as docs or tests only. The planner may skip only before its first step, only with the default goal, and only when the brief shows the whole change: every file committed and shown in full, on a working tree that matches HEAD. A change with no files on a clean working tree can be skipped too. The run passes with no step, `run.explore.ended` reads `skipped`, the assessment says why, and the comment headline reads `nothing to explore`.
