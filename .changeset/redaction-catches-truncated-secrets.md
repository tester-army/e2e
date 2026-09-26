---
'e2e': patch
---

An observed name or text the engine cut at its length limit no longer leaks the start of a secret it stopped partway through. When a cut field ends with the leading part of a registered value, that part becomes `<secret:name>` in model input, the failure screen, reports, and the trace cache.
