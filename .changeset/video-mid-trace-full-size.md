---
'@e2e-dev/web': patch
---

A video started while a trace is already running fills the viewport. The trace sized the page's screencast for itself first, so the video came out at the trace's size, padded with grey. The running trace is now split around the start: its segment so far is saved and it resumes on the video's screencast, also when the video fails to start. A video stop that reports a lost segment no longer carries the segments that did finalize into the next recording of the same attempt.
