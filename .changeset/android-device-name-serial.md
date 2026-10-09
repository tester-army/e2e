---
'@e2e-dev/mobile': patch
---

Resolve a configured physical Android device name to its inventory serial before warm-up, and preserve that serial in the worker binding so later agent-device commands select the same phone.
