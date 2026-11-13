---
"e2e": patch
---

The `markdown` reporter and the trace pages escape `&`, so a test title or message holding entity text such as `&copy;` or `&lt;b&gt;` shows as written instead of rendering as `©` or `<b>`.
