---
"@e2e-dev/mobile": patch
---

A missing agent-device session is recognized by agent-device's `SESSION_NOT_FOUND` code and its `session_or_device_selector_required` reason (0.21.21) instead of a pattern over the message, so a reworded message can no longer change whether a failure reports as `APP_NOT_OPEN`.
