---
'e2e': patch
---

A recorded tap on a row of a windowed list no longer depends on which row the list rendered first. The container key of a row was its list's first text, a scroll position on Android (`Row 0512 in Row 0500`), so the replay found the row and still handed off whenever the window started one row later.
