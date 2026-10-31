---
"e2e": patch
---

`e2e explore --changed-since` can skip a change no user can see, such as docs or tests only. The planner may skip only before its first step, and only when the brief shows every changed file in full. The run passes with no step, `run.explore.ended` reads `skipped`, the assessment names the files and says why, and the comment headline reads `nothing to explore`. The skip is the planner's call on the change alone, made after the app opens, without judging the app.
