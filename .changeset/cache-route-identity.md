---
'e2e': minor
---

A recording's starting and ending screens are compared as routes, not URLs. A location is reduced to its pathname with every segment that names a record abstracted: uuids, hex and digit runs, random tokens, text with spaces, and any value the call marked with `unique()` in whatever spelling the URL gives it, its slug included. The query, the fragment, and a trailing slash are ignored; an app that routes in the fragment (`/#/companies/1`) routes by that path. Where two locations still differ in one segment, a slug of a record the runner never saw, the screen decides: at the start, a signature of the screen's controls recorded with the trace; at the end, the recorded anchors. The replay policy version changes, so existing caches start over.
