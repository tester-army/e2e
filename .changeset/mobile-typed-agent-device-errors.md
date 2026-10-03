---
"@e2e-dev/mobile": patch
---

Recognize agent-device's stale-ref refusals by their `details.reason` instead of their message, so every one of them is retried as `NODE_STALE`. A ref minted from a superseded snapshot, a plain ref the current snapshot does not cover, and a ref it did not issue used to fail the action, since their messages did not match.
