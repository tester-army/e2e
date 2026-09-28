---
'e2e': patch
---

An observed name or text the engine cut at its length limit no longer leaks the start of a secret it stopped partway through. When a cut field ends with 8 or more leading characters of a registered value (half of a value shorter than 16), that part becomes `<secret:name>` in model input, the failure screen, reports, and the trace cache. A Playwright trace from a session a secret was filled on also masks any run of 8 or more characters of a registered value, since it keeps the page's text as read, before any cut was redacted.
