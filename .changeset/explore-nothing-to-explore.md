---
"e2e": patch
---

`e2e explore --changed-since` can skip a change no user can see, such as docs or tests only. It skips only with no goal given, and only when the planner read the whole change on a clean working tree. The run passes with no step, `run.explore.ended` reads `skipped`, and the comment headline reads `nothing to explore`.
