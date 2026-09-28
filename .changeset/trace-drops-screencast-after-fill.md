---
'e2e': patch
---

A Playwright trace from an attempt that filled a secret no longer keeps its screencast frames. A secret filled into an ordinary visible field showed in those JPEGs while `app.screenshot()` was denied and the trace said `redaction: 'complete'`. The runner now drops every `screencast/` entry, every `screencast-frame` record, and any image a record names when it rewrites the trace, so the label holds; the actions, DOM snapshots, and network stay. A trace from an attempt that filled no secret keeps its frames.
