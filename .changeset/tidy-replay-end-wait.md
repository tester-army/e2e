---
'e2e': patch
---

Exclude a failed replay's wait from the refreshed trace's end-state wait budget. Repeated hand-offs that the executor settles without another action no longer grow the wait to 120 seconds.
