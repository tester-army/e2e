---
'@e2e-dev/mobile': patch
---

Keep healthy agent-device sessions open on leased devices across worker replacement, so later tests no longer fail with "Device is already in use". The engine also retries a failed provider recording stop before the worker's next attempt.
