---
"@e2e-dev/mobile": patch
---

Recognize agent-device's stale-ref refusals by their `details.reason` instead of matching their message, so a reworded message in a later agent-device release cannot turn a stale ref into an engine failure. Every ref-frame reason agent-device 0.21.20 sends is covered, including the three whose messages the old pattern did not match.
